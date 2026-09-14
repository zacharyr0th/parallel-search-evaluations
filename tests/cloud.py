"""Run against a signed-in deployment: python3 tests/cloud.py BASE_URL COOKIE_FILE."""
import json,sys
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
base=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:3001'
if len(sys.argv) < 3: raise SystemExit('Usage: python3 tests/cloud.py BASE_URL COOKIE_FILE')
auth=Path(sys.argv[2]).read_text().strip()
def request(path,body=None,login=True,origin=None):
 headers={'Content-Type':'application/json','X-Requested-With':'SearchEvaluations','Origin':origin or base}
 if login:headers['Cookie']=auth
 with urlopen(Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=120) as r:return json.load(r)
for path in ['/api/evaluations']:
 try:request(path,login=False);raise AssertionError('Unauthenticated access allowed')
 except HTTPError as e:assert e.code==401;e.close()
try:request('/api/search',{'query':'test','modes':['fast']},origin='https://evil.example');raise AssertionError('Origin accepted')
except HTTPError as e:assert e.code==403;e.close()
data=request('/api/search',{'query':'Parallel Search API documentation','modes':['turbo','fast'],'blind':True})
assert data['blind'] and not data['revealed_at']
assert all(r['status']=='completed' and r['mode'] in ['A','B'] and len(r['results'])==5 for r in data['runs'])
assert all('request' not in r and 'response' not in r for r in data['runs'])
result=data['runs'][0]['results'][0]
# A grade is the whole point of the review loop, so the check records one. `relevance` and
# `issues` are both required: the retired binary judgment is refused, not ignored.
body={'result_id':result['id'],'version':0,'relevance':3,'issues':[],'notes':'Deployment verification: official Search documentation.'}
saved=request('/api/feedback',body)
assert saved['relevance']==3 and saved['version']==1
try:request('/api/feedback',body);raise AssertionError('Stale write accepted')
except HTTPError as e:assert e.code==409;e.close()
reopened=request('/api/evaluation?id='+data['id'])
stored=reopened['runs'][0]['results'][0]
assert stored['notes']==body['notes']
assert stored['relevance']==3,'the grade did not persist'
export=request('/api/export?id='+data['id'])
assert all(r['mode'] in ['A','B'] for r in export['runs'])
assert any(s['id']==data['id'] for s in request('/api/evaluations'))
print('PASS: access control, origin check, live two-mode search, blinded output, feedback, conflict, reopen, export, history.')
