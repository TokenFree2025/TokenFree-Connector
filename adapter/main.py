"""TokenFree's constrained desktop adapter. Never starts a Codex runtime."""
import copy
import hashlib
import json
import os
import plistlib
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))
from codex_bridge.ipc import DesktopIPC, IPCError
from codex_bridge.transport import ipc_endpoint
from codex_bridge.model import apply_patches, normalize_state, ordered_turns

MAX_LINE = 1024 * 1024
SUPPORTED = {'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
             'item/tool/requestUserInput', 'tool/requestUserInput', 'bridge/requestUserInputAsync'}

class Fault(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

class Adapter:
    def __init__(self, home=None, endpoint=None, emit=None):
        self.home = Path(home or Path.home() / '.codex')
        self.emit = emit or (lambda event: None)
        self.condition = threading.Condition(threading.RLock())
        self.sessions = {}
        self.incompatible = False
        self.ipc = DesktopIPC(endpoint or ipc_endpoint(self.home), self.event, self.disconnected)

    def disconnected(self):
        with self.condition:
            for session in self.sessions.values():
                session['connected'] = False
            self.condition.notify_all()
        self.emit({'type': 'status', 'ipc': False, 'code': 'IPC_DISCONNECTED'})

    def connect(self):
        try:
            self.ipc.connect()
        except Exception:
            raise Fault('IPC_UNAVAILABLE') from None

    def status(self):
        app = None
        for path in ['/Applications/Codex.app', '/Applications/ChatGPT.app', str(Path.home()/'Applications/Codex.app')]:
            try:
                with open(path + '/Contents/Info.plist', 'rb') as f:
                    info = plistlib.load(f)
                app = {'version': info.get('CFBundleShortVersionString'), 'build': info.get('CFBundleVersion')}
                break
            except OSError:
                pass
        try:
            processes = subprocess.run(['ps', '-axo', 'comm'], capture_output=True, text=True, timeout=3).stdout
            running = any('/Contents/' in s and ('Codex' in s or 'ChatGPT.app/Contents/MacOS/' in s) for s in processes.splitlines())
        except Exception:
            running = False
        error = None
        try:
            self.connect()
        except Fault as e:
            error = e.code if running else 'CODEX_NOT_RUNNING'
        if self.incompatible:
            error = 'IPC_INCOMPATIBLE'
        return {'appRunning': running or bool(self.ipc.client_id), 'ipcConnected': bool(self.ipc.client_id),
                'app': app, 'code': error, 'platform': sys.platform,
                'compatibility': 'incompatible' if self.incompatible else ('v11-observed' if any(s.get('connected') for s in self.sessions.values()) else 'awaiting-session-snapshot')}

    def catalog(self):
        # Metadata only, read-only connection. No rollout files, auth or config are read.
        databases = sorted(self.home.glob('state_*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True)
        if not databases:
            raise Fault('CATALOG_UNAVAILABLE')
        try:
            with sqlite3.connect(databases[0].as_uri() + '?mode=ro', uri=True, timeout=2) as db:
                db.row_factory = sqlite3.Row
                cols = {r[1] for r in db.execute('PRAGMA table_info(threads)')}
                fields = [c for c in ('id','title','name','cwd','originator','source','thread_source') if c in cols]
                rows = db.execute('SELECT ' + ','.join(fields) + ' FROM threads ORDER BY updated_at DESC')
                result = []
                for row in rows:
                    r = dict(row)
                    if r.get('originator') not in ('Codex Desktop','codex_work_desktop','codex_mobile_bridge') and not (r.get('originator') is None and r.get('source') == 'vscode'):
                        continue
                    if r.get('thread_source') == 'subagent' or '"subagent"' in (r.get('source') or ''):
                        continue
                    cwd = r.get('cwd') or ''
                    result.append({'sessionId':r['id'], 'title':r.get('name') or r.get('title') or 'Untitled',
                                   'projectId':hashlib.sha256(cwd.encode()).hexdigest()[:24], 'cwd':cwd, 'host':'local'})
                    if len(result) > 5000:
                        raise Fault('MESSAGE_TOO_LARGE')
                return result
        except (OSError, sqlite3.Error):
            raise Fault('CATALOG_UNAVAILABLE') from None

    def event(self, message):
        if message.get('method') == 'client-status-changed':
            p = message.get('params', {})
            if p.get('status') == 'disconnected':
                with self.condition:
                    for s in self.sessions.values():
                        if s.get('owner') == p.get('clientId'):
                            s['connected'] = False
                self.emit({'type':'status', 'code':'OWNER_UNAVAILABLE'})
            return
        if message.get('method') != 'thread-stream-state-changed':
            return
        p = message.get('params', {})
        sid = p.get('conversationId')
        if p.get('hostId') != 'local' or sid not in self.sessions:
            return
        with self.condition:
            s = self.sessions[sid]
            if message.get('version') != 11:
                self.incompatible = True
                s['connected'] = False
                self.condition.notify_all()
                self.emit({'type':'status','code':'IPC_INCOMPATIBLE'})
                return
            change = p.get('change', {})
            try:
                if change.get('type') == 'snapshot':
                    if change['conversationState']['id'] != sid:
                        return
                    s['state'] = copy.deepcopy(change['conversationState'])
                    s['owner'] = message.get('sourceClientId')
                elif change.get('type') == 'patches':
                    if not s.get('connected') or s.get('owner') != message.get('sourceClientId'):
                        return
                    if s.get('revision') != change['baseRevision']:
                        raise ValueError()
                    s['state'] = apply_patches(s['state'], change['patches'])
                else:
                    return
                s['revision'] = change['revision']
                s['connected'] = True
                s['serial'] += 1
                self.condition.notify_all()
            except (ValueError, KeyError, TypeError, IndexError):
                s['connected'] = False
                self.condition.notify_all()
                # Ask for a full snapshot; never apply a patch against a different base.
                self.ipc.follow(sid, s.get('owner'))
                return
        self.emit({'type':'session', 'sessionId':sid, 'snapshot':self.view(sid)})

    def view(self, sid):
        with self.condition:
            s = self.sessions[sid]
            view = normalize_state(copy.deepcopy(s.get('state') or {'id':sid}), s.get('connected',False))
            view['revision'] = s.get('revision')
        # The wire carries a bounded recent window. Earlier history remains in the desktop.
        view['historyTruncated'] = len(view['turns']) > 30
        view['turns'] = view['turns'][-30:]
        for turn in view['turns']:
            turn.pop('diff', None)
            turn.pop('error', None)
            messages = turn['messages']
            if len(messages) > 100:
                view['historyTruncated'] = True
            turn['messages'] = messages[-100:]
            for m in turn['messages']:
                for key in list(m):
                    if key not in ('id','kind','role','text','status','phase','title','requestId'):
                        del m[key]
                if m.get('role') not in ('user','assistant'):
                    m['text'] = '' # Tool arguments and errors do not cross as diagnostic text.
                m['text'] = str(m.get('text',''))[:16000]
        for r in view['requests']:
            r['id'] = str(r['id'])
            r['supported'] = bool(r.get('supported')) and r['method'] in SUPPORTED
            if not r['supported']:
                r['params'] = {}
            elif 'changes' in r['params']:
                r['params']['changes'] = r['params']['changes'][:30]
        while len(json.dumps(view).encode()) > 700000 and view['turns']:
            view['turns'].pop(0)
            view['historyTruncated'] = True
        view['capabilities'] = {'send':view['connected'], 'stop':view['connected'], 'approval':True,
                                'userInput':True, 'create':False, 'remoteHosts':False}
        return view

    def attach(self, sid, fresh=False):
        uuid.UUID(sid)
        self.connect()
        if self.incompatible:
            raise Fault('IPC_INCOMPATIBLE')
        with self.condition:
            if sid not in self.sessions:
                self.sessions[sid] = {'serial':0, 'connected':False}
            s = self.sessions[sid]
            if s['connected'] and not fresh:
                return self.view(sid)
            serial = s['serial']
        # Follow broadcast discovers background owners that don't answer explicit discovery.
        self.ipc.follow(sid, None)
        with self.condition:
            self.condition.wait_for(lambda: s['serial'] > serial or self.incompatible or not self.ipc.client_id, timeout=6)
            if self.incompatible:
                raise Fault('IPC_INCOMPATIBLE')
            if s['serial'] <= serial or not s['connected']:
                raise Fault('OWNER_UNAVAILABLE')
        return self.view(sid)

    def scope(self, ids):
        with self.condition:
            for sid in list(self.sessions):
                if sid not in ids:
                    if self.ipc.client_id:
                        self.ipc.follow(sid, self.sessions[sid].get('owner'), False)
                    del self.sessions[sid]
        return {'ok':True}

    def perform(self, method, p):
        if method == 'status': return self.status()
        if method == 'catalog': return self.catalog()
        if method == 'scope': return self.scope(p['sessionIds'])
        if method == 'read': return self.attach(p['sessionId'], True)
        sid = p['sessionId']
        view = self.attach(sid, True)
        s = self.sessions[sid]
        payload = {'conversationId':sid}
        if method == 'send':
            if view['status'] != 'idle': raise Fault('SESSION_BUSY')
            if not p['text'].strip() or len(p['text']) > 20000: raise Fault('INVALID_REQUEST')
            native = 'thread-follower-start-turn'
            payload['turnStart'] = {'request':{'threadId':sid, 'input':[{'type':'text','text':p['text'],'text_elements':[]}],
                                                'clientUserMessageId':p['operationId']},
                                    'context':{'inheritThreadSettings':True,'attachments':[],'commentAttachments':[]}}
        elif method == 'stop':
            active = next((t for t in reversed(view['turns']) if t['status'] == 'inProgress'), None)
            if not active or active['id'] != p['turnId']: raise Fault('STALE_TURN')
            native = 'thread-follower-interrupt-turn'
            payload.update(mode='user-stop', expectedTurnId=p['turnId'])
        elif method == 'respond':
            req = next((r for r in view['requests'] if r['id'] == str(p['approvalId'])), None)
            if not req: raise Fault('STALE_APPROVAL')
            if not req['supported']: raise Fault('DESKTOP_ACTION_REQUIRED')
            if req['method'] == 'bridge/requestUserInputAsync':
                answers = p.get('answers', {})
                questions = req['params']['questions']
                if set(answers) != {q['id'] for q in questions} or any(not isinstance(v, list) or len(v) != 1 or not isinstance(v[0], str) or not v[0].strip() or len(v[0]) > 20000 for v in answers.values()):
                    raise Fault('INVALID_REQUEST')
                replies = [{'questionItemId':q['id'], 'question':q['question'], 'answer':answers[q['id']][0]} for q in questions]
                text = '<send_user_message_question_reply>\n' + json.dumps(replies,ensure_ascii=False,separators=(',',':')) + '\n</send_user_message_question_reply>'
                request = {'threadId':sid, 'input':[{'type':'text','text':text,'text_elements':[]}], 'clientUserMessageId':p['operationId']}
                context = {'inheritThreadSettings':True,'attachments':[],'commentAttachments':[]}
                if view['status'] == 'active':
                    native = 'thread-follower-steer-turn'
                    payload.update(input=request['input'],clientUserMessageId=p['operationId'],restoreMessage={'request':request,'context':context},attachments=[])
                elif view['status'] == 'idle':
                    native = 'thread-follower-start-turn'
                    payload['turnStart'] = {'request':request,'context':context}
                else:
                    raise Fault('SESSION_BUSY')
                try:
                    self.ipc.request(native,payload,target=s['owner'],timeout=30)
                except IPCError:
                    raise Fault('OPERATION_UNCERTAIN') from None
                return {'status':'accepted','operationId':p['operationId']}
            raw = next(r for r in s['state'].get('requests',[]) if str(r['id']) == req['id'])
            payload['requestId'] = raw['id']
            if req['method'] in ('item/tool/requestUserInput','tool/requestUserInput'):
                native = 'thread-follower-submit-user-input'
                answers = p.get('answers',{})
                if set(answers) != {q['id'] for q in req['params']['questions']}: raise Fault('INVALID_REQUEST')
                payload['response'] = {'answers':{k:{'answers':v} for k,v in answers.items()}}
            else:
                native = 'thread-follower-command-approval-decision' if 'commandExecution' in req['method'] else 'thread-follower-file-approval-decision'
                decision = p.get('decision')
                if decision not in ('accept','decline','cancel'): raise Fault('INVALID_REQUEST')
                if req['params'].get('availableDecisions') and decision not in req['params']['availableDecisions']: raise Fault('INVALID_REQUEST')
                payload['decision'] = decision
        else:
            raise Fault('UNSUPPORTED')
        try:
            self.ipc.request(native, payload, target=s['owner'], timeout=30)
        except IPCError:
            # A native error may arrive after the write was accepted. Never retry automatically.
            raise Fault('OPERATION_UNCERTAIN') from None
        return {'status':'accepted','operationId':p['operationId']}

    def close(self):
        self.ipc.close()


def main():
    lock = threading.Lock()
    def output(obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(',',':'))
        if len(data.encode()) > MAX_LINE:
            data = json.dumps({'id':obj.get('id'),'error':'MESSAGE_TOO_LARGE'})
        with lock:
            sys.stdout.write(data+'\n')
            sys.stdout.flush()
    adapter = Adapter(emit=lambda event: output({'event':event}))
    try:
        for line in sys.stdin:
            if len(line.encode()) > MAX_LINE: break
            request = {}
            try:
                request = json.loads(line)
                result = adapter.perform(request['method'],request.get('params',{}))
                output({'id':request['id'],'result':result})
            except Fault as e:
                output({'id':request.get('id'),'error':e.code})
            except Exception:
                output({'id':request.get('id'),'error':'ADAPTER_ERROR'})
    finally:
        adapter.close()

if __name__ == '__main__': main()
