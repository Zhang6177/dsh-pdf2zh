import os,sys,unittest
from pathlib import Path
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pipeline'))
import translate as T

class ProtocolTests(unittest.TestCase):
    def translator(self, api='openai', url='https://api.example.com/v1'):
        with patch.dict(os.environ,{'PDF2ZH_API':api,'PDF2ZH_API_KEY':'test-only-key'}):
            return T.Translator(url=url,model='test-model')

    def test_openai_strict_and_root_url(self):
        tr=self.translator(url='https://api.example.com')
        self.assertEqual(tr._messages_url(),'https://api.example.com/v1/chat/completions')
        response=Mock(status_code=200)
        response.json.return_value={'choices':[{'message':{'content':'1. 译文'},'finish_reason':'stop'}]}
        with patch.object(T,'_thread_session') as session:
            session.return_value.post.return_value=response
            self.assertEqual(tr._translate_once(['Text']),['译文'])
            payload=session.return_value.post.call_args.kwargs['json']
            self.assertNotIn('chat_template_kwargs',payload)

    def test_anthropic_messages(self):
        tr=self.translator('anthropic')
        self.assertEqual(tr._messages_url(),'https://api.example.com/v1/messages')
        self.assertEqual(tr._headers()['x-api-key'],'test-only-key')
        response=Mock(status_code=200)
        response.json.return_value={'content':[{'type':'text','text':'1. 译文'}],'stop_reason':'end_turn'}
        with patch.object(T,'_thread_session') as session:
            session.return_value.post.return_value=response
            self.assertEqual(tr._translate_once(['Text']),['译文'])
            self.assertIn('system',session.return_value.post.call_args.kwargs['json'])

    def test_permanent_error_is_not_retried(self):
        tr=self.translator()
        response=Mock(status_code=401)
        response.raise_for_status.side_effect=T.requests.HTTPError('401 unauthorized')
        with patch.object(T,'_thread_session') as session:
            session.return_value.post.return_value=response
            with self.assertRaises(RuntimeError):tr.translate_batch(['Text'])
            self.assertEqual(session.return_value.post.call_count,1)

    def test_missing_api_and_redaction(self):
        with patch.dict(os.environ,{'PDF2ZH_VLLM_URL':'','PDF2ZH_MODEL':''}):
            with self.assertRaises(ValueError):T.Translator()
        with patch.dict(os.environ,{'PDF2ZH_API_KEY':'test-only-key'}):
            self.assertNotIn('test-only-key',T.redact('failed: test-only-key'))

if __name__=='__main__':unittest.main()
