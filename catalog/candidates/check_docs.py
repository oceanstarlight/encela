# Shows how each converted document differs from its source at the pinned
# commit (frontmatter aside). Every difference must be one the third-party
# notices describe.
import json, os, re, difflib, sys
REPO='/home/user/encela'
man=json.load(open(REPO+'/catalog/candidates/docs-manifest.json'))
def body(path):
    t=open(path,encoding='utf-8').read().replace('\r\n','\n')
    m=re.match(r'^---\n(.*?)\n---\n?',t,re.S)
    return (t[m.end():] if m else t).strip().split('\n')
total=0; changed=0
for x in man:
    pairs=[(x['source'], os.path.join(REPO,x['file']))]
    for c in x['companions']:
        pairs.append((os.path.join(os.path.dirname(x['source']),c), os.path.join(REPO,os.path.dirname(x['file']),x['name'],c)))
    for i,(src,dst) in enumerate(pairs):
        a=body(src) if i==0 else open(src,encoding='utf-8').read().replace('\r\n','\n').strip().split('\n')
        b=body(dst) if i==0 else open(dst,encoding='utf-8').read().replace('\r\n','\n').strip().split('\n')
        d=[l for l in difflib.unified_diff(a,b,lineterm='',n=0) if not l.startswith(('---','+++','@@'))]
        total+=1
        if d:
            changed+=1
            if '-q' not in sys.argv:
                print('\n==',os.path.relpath(dst,REPO+'/catalog/external'),f'({len(d)} lines differ)')
                for l in d: print('  ',l[:230])
print(f'\n{total} files checked, {changed} differ from their source')
