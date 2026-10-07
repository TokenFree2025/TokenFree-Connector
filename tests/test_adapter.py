import copy
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapter'))
from main import Adapter, Fault
SID='01a115e3-585e-7d70-9265-a56da0770169'
OP='01a115e3-585e-7d70-9265-a56da0770168'

class Endpoint:
    def __init__(self, path):
        self.path=path
        self.socket=socket.socket(socket.AF_UNIX)
        self.socket.bind(path);self.socket.listen();self.socket.settimeout(.1)
        self.closed=False;self.client=None;self.lock=threading.Lock();self.requests=[];self.revision=1;self.version=11
        self.state={'id':SID,'title':'fixture','threadRuntimeStatus':{'type':'idle'},'turns':[],'requests':[], 'latestModel':'fixture-model', 'modelProvider':'fixture-provider'}
        self.worker=threading.Thread(target=self.run,daemon=True);self.worker.start()
    def send(self,m):
        data=json.dumps(m).encode()
        with self.lock:self.client.sendall(struct.pack('<I',len(data))+data)
    def snapshot(self):
        self.send({'type':'broadcast','method':'thread-stream-state-changed','version':self.version,'sourceClientId':'owner',
                   'params':{'hostId':'local','conversationId':SID,'change':{'type':'snapshot','revision':self.revision,'conversationState':self.state}}})
    def exact(self,c,n):
        b=b''
        while len(b)<n:
            p=c.recv(n-len(b))
            if not p:raise EOFError()
            b+=p
        return b
    def run(self):
        while not self.closed:
            try:c,_=self.socket.accept()
            except socket.timeout:continue
            except OSError:return
            self.client=c
            try:
                while not self.closed:
                    n=struct.unpack('<I',self.exact(c,4))[0];m=json.loads(self.exact(c,n));method=m.get('method')
                    if m['type']=='broadcast':
                        if method=='thread-stream-following-changed' and m['params']['following']:self.snapshot()
                        continue
                    self.requests.append(m)
                    if method=='thread-follower-start-turn':
                        self.state['threadRuntimeStatus']={'type':'active'}
                        self.state['turns']=[{'turnId':'t1','status':'inProgress','items':[{'id':'a','type':'agentMessage','text':'streaming'}]}]
                        self.revision+=1;self.snapshot()
                    if method=='thread-follower-interrupt-turn':
                        self.state['threadRuntimeStatus']={'type':'idle'};self.state['turns'][0]['status']='interrupted';self.revision+=1;self.snapshot()
                    if method in ('thread-follower-command-approval-decision','thread-follower-submit-user-input','thread-follower-file-approval-decision'):
                        self.state['requests']=[];self.revision+=1;self.snapshot()
                    self.send({'type':'response','requestId':m['requestId'],'resultType':'success','handledByClientId':'owner','result':{'clientId':'fixture'} if method=='initialize' else {'ok':True}})
            except (OSError,EOFError):pass
            finally:c.close()
    def disconnect(self):
        try:self.client.shutdown(socket.SHUT_RDWR)
        except (OSError,AttributeError):pass
    def close(self):
        self.closed=True;self.disconnect();self.socket.close();self.worker.join(1)
        try:os.unlink(self.path)
        except OSError:pass

class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='tfc-',dir='/tmp');self.path=self.tmp.name+'/ipc'
        self.fixture=Endpoint(self.path);self.events=[];self.adapter=Adapter(home=self.tmp.name,endpoint=self.path,emit=self.events.append)
    def tearDown(self):self.adapter.close();self.fixture.close();self.tmp.cleanup()
    def call(self,method,**params):return self.adapter.perform(method,{'sessionId':SID,'operationId':OP,**params})
    def test_same_owner_send_inherits_settings_and_streams(self):
        v=self.call('read');self.assertTrue(v['connected']);self.assertEqual(v['id'],SID)
        r=self.call('send',text='hello');self.assertEqual(r['status'],'accepted')
        m=next(r for r in self.fixture.requests if r['method']=='thread-follower-start-turn')
        self.assertEqual(m['targetClientId'],'owner');p=m['params']['turnStart'];self.assertEqual(p['request']['threadId'],SID)
        self.assertTrue(p['context']['inheritThreadSettings']);self.assertNotIn('modelProvider',p['request']);self.assertNotIn('approvalPolicy',p['request'])
        self.assertTrue(any(e.get('snapshot',{}).get('status')=='active' for e in self.events))
        self.assertEqual(self.call('read')['turns'][0]['messages'][0]['text'],'streaming')
    def test_busy_and_stale_stop_then_terminal(self):
        self.call('send',text='hello')
        with self.assertRaisesRegex(Fault,'SESSION_BUSY'):self.call('send',text='twice')
        with self.assertRaisesRegex(Fault,'STALE_TURN'):self.call('stop',turnId='old')
        self.call('stop',turnId='t1');self.assertEqual(self.call('read')['turns'][0]['status'],'interrupted')
    def test_accept_decline_and_stale_approval(self):
        for decision in ('accept','decline'):
            self.fixture.state['requests']=[{'id':7,'method':'item/commandExecution/requestApproval','params':{'command':'echo test','availableDecisions':['accept','decline']}}]
            self.call('respond',approvalId='7',decision=decision)
            m=self.fixture.requests[-1];self.assertEqual(m['params']['decision'],decision)
            with self.assertRaisesRegex(Fault,'STALE_APPROVAL'):self.call('respond',approvalId='7',decision=decision)
        self.fixture.state['requests']=[{'id':9,'method':'unknown/approval','params':{'secret':'hidden'}}]
        with self.assertRaisesRegex(Fault,'DESKTOP_ACTION_REQUIRED'):self.call('respond',approvalId='9',decision='accept')
        self.assertEqual(self.call('read')['requests'][0]['params'],{})
    def test_desktop_resolves_before_browser(self):
        self.fixture.state['requests']=[{'id':7,'method':'item/fileChange/requestApproval','params':{}}]
        self.call('read');self.fixture.state['requests']=[]
        with self.assertRaisesRegex(Fault,'STALE_APPROVAL'):self.call('respond',approvalId='7',decision='accept')
    def test_input(self):
        self.fixture.state['requests']=[{'id':5,'method':'item/tool/requestUserInput','params':{'questions':[{'id':'q','question':'Which?'}]}}]
        self.call('respond',approvalId='5',answers={'q':['yes']});self.assertEqual(self.fixture.requests[-1]['params']['response'],{'answers':{'q':{'answers':['yes']}}})
    def test_async_input_exact_item_id_and_active_steer(self):
        self.fixture.state['threadRuntimeStatus']={'type':'active'}
        self.fixture.state['turns']=[{'turnId':'t1','status':'inProgress','items':[{'id':'q1','type':'agentMessage','text':'Continue?', 'questions':[{'title':'Continue?','options':['Yes','No']}]}]}]
        req=self.call('read')['requests'][0]
        self.assertTrue(req['supported'])
        self.call('respond',approvalId=req['id'],answers={req['params']['questions'][0]['id']:['Yes']})
        m=self.fixture.requests[-1];self.assertEqual(m['method'],'thread-follower-steer-turn')
        self.assertIn('[\\"request_user_input_async\\",\\"q1\\",0]',m['params']['input'][0]['text'])

    def test_protocol_version_fails_closed(self):
        self.fixture.version=12
        with self.assertRaisesRegex(Fault,'IPC_INCOMPATIBLE'):self.call('read')
        with self.assertRaisesRegex(Fault,'IPC_INCOMPATIBLE'):self.call('send',text='no')
        self.assertFalse(any(r['method']=='thread-follower-start-turn' for r in self.fixture.requests))
    def test_disconnect_reconnect_same_session(self):
        self.call('read');self.fixture.disconnect()
        for _ in range(100):
            if not self.adapter.ipc.client_id:break
            time.sleep(.01)
        self.assertTrue(self.call('read')['connected']);self.assertEqual(self.call('read')['id'],SID)
    def test_bad_patch_resnapshots(self):
        self.call('read')
        self.adapter.event({'method':'thread-stream-state-changed','version':11,'sourceClientId':'owner','params':{'hostId':'local','conversationId':SID,'change':{'type':'patches','baseRevision':999,'revision':1000,'patches':[]}}})
        self.assertEqual(self.call('read')['revision'],1)
    def test_unavailable_and_unsupported(self):
        self.fixture.close()
        with self.assertRaisesRegex(Fault,'IPC_UNAVAILABLE'):self.call('read')
    def test_no_tool_argument_error_leak(self):
        self.fixture.state['turns']=[{'turnId':'x','items':[{'type':'mcpToolCall','arguments':{'token':'secret-value'}},{'type':'error','message':'secret-error'}]}]
        value=json.dumps(self.call('read'));self.assertNotIn('secret-value',value);self.assertNotIn('secret-error',value)
    def test_scope_revocation_unfollows(self):
        self.call('read');self.adapter.scope([]);self.assertFalse(self.adapter.sessions)

if __name__=='__main__':unittest.main()
