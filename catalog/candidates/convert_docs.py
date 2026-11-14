# Converts verified document candidates into catalog files: the body as it
# is in the source repository at the pinned commit, under Encela's own
# frontmatter (titles, provenance, license). Edits a file needs are listed
# in a manifest and applied afterwards.
import json, os, re, shutil, subprocess, sys
REPO='/home/user/encela'; C=REPO+'/catalog/candidates/'; EXT=REPO+'/catalog/external/'
SRC={'addyosmani/agent-skills':'addyosmani_agent_skills','github/awesome-copilot':'github_awesome_copilot',
     'PatrickJS/awesome-cursorrules':'patrickjs_cursorrules','gamedev-skills/awesome-gamedev-agent-skills':'gamedev_skills',
     'expo/skills':'expo_skills','huggingface/skills':'huggingface_skills','getsentry/skills':'getsentry_skills',
     'wshobson/agents':'wshobson_agents'}
SKIP={'secure-coding','github-actions'}
UI=['**/*.html','**/*.css','**/*.scss','**/*.jsx','**/*.tsx','**/*.vue','**/*.svelte']
PATHS={'accessibility':UI,'web-performance':UI,'vue':['**/*.vue'],'svelte':['**/*.svelte','**/*.svelte.ts','**/*.svelte.js'],
       'tailwind-v4':['vite.config.*','**/*.css'],'sql-server-safe-tsql':['**/*.sql']}
KIND={'web-performance':'rule'}
q=lambda s: json.dumps(s, ensure_ascii=False)
def git(d,*a): return subprocess.run(['git','-C',d,*a],capture_output=True,text=True)
def ensure(clone, repo, commit):
    if not os.path.isdir(clone):
        subprocess.run(['git','clone','-q','--depth','1','https://github.com/'+repo,clone],check=True)
    if git(clone,'rev-parse','HEAD').stdout.strip()!=commit:
        r=git(clone,'fetch','-q','--depth','1','origin',commit)
        if r.returncode: raise SystemExit(f'cannot fetch {repo}@{commit}: {r.stderr}')
        git(clone,'checkout','-q',commit)
    assert git(clone,'rev-parse','HEAD').stdout.strip()==commit, (repo, commit)
manifest=[]; made=[]
for area in ['rules','skills-engineering','skills-domain','subagents']:
    for x in json.load(open(C+area+'.checked.json')):
        if x['verdict']=='reject' or x.get('recommend') is False or x['name'] in SKIP: continue
        if x['repo'] not in SRC: print('NO SOURCE DIR', x['repo']); continue
        clone=x.get('cloneDir') or ''
        if not clone or not os.path.isdir(clone):
            clone='/tmp/claude-0/-home-user-ai-management-pg-fo-desktop/652b98ec-4f9a-58ab-bbec-7ba87a86d59c/scratchpad/repos/'+x['repo'].replace('/','__')
        ensure(clone, x['repo'], x['commit'])
        src=os.path.join(clone,x['path'])
        text=open(src,encoding='utf-8').read().replace('\r\n','\n')
        m=re.match(r'^---\n(.*?)\n---\n?',text,re.S)
        body=(text[m.end():] if m else text).strip()+'\n'
        kind=KIND.get(x['name'],x['kind'])
        name=x['name']
        d=EXT+SRC[x['repo']]; os.makedirs(d,exist_ok=True)
        out=os.path.join(d,name+'.md')
        if os.path.exists(out): print('EXISTS, skipped:', out); continue
        fm=['kind: '+('agent' if kind=='subagent' else kind),'title: '+x['titleKo'],'title_en: '+x['titleEn'],
            'summary: '+x['summaryKo'],'summary_en: '+x['summaryEn']]
        if x.get('detailKo'): fm.append('detail: '+x['detailKo'])
        if x.get('detailEn'): fm.append('detail_en: '+x['detailEn'])
        fm+=['category: '+x['categoryKo'],'category_en: '+x['categoryEn'],'name: '+name]
        if x.get('description'): fm.append('description: '+q(' '.join(x['description'].split())))
        paths=PATHS.get(name, x.get('paths') or []) if kind=='rule' else []
        if paths: fm.append('paths:'); fm+=[f'  - {q(p)}' for p in paths]
        fm+=['license: '+x['license'],'copyright: '+q(x['copyright']),'source_repo: '+x['repo'],'source_commit: '+x['commit'],
             'source_path: '+x['path'],'license_path: '+x['licensePath']]
        for line in fm: assert '\n' not in line, line
        open(out,'w',encoding='utf-8').write('---\n'+'\n'.join(fm)+'\n---\n'+body)
        comps=[]
        for rel in x.get('companions') or []:
            if not rel.endswith('.md') or '..' in rel: print('companion skipped:',name,rel); continue
            s=os.path.join(os.path.dirname(src),rel); t=os.path.join(d,name,rel)
            os.makedirs(os.path.dirname(t),exist_ok=True); shutil.copyfile(s,t); comps.append(rel)
        lic=os.path.join(clone,x['licensePath'])
        ldst=os.path.join(d,'LICENSE')
        if not os.path.exists(ldst): shutil.copyfile(lic,ldst)
        elif open(ldst).read().strip()!=open(lic).read().strip():
            alt=os.path.join(d,'LICENSE-'+name)
            # A folder with its own license text keeps it beside the main one.
            if x['licensePath']!='LICENSE': shutil.copyfile(lic,alt); print('extra license text:',alt)
        made.append((kind,name,SRC[x['repo']],len(body),len(comps)))
        manifest.append({'file':os.path.relpath(out,REPO),'source':src,'kind':kind,'name':name,'repo':x['repo'],'commit':x['commit'],
                         'path':x['path'],'companions':comps,'edits':x.get('editsNeeded','').strip(),'license':x['license'],'copyright':x['copyright']})
json.dump(manifest,open(os.path.dirname(__file__)+'/docs-manifest.json','w'),ensure_ascii=False,indent=1)
for m in made: print(*m)
print(len(made),'documents;',sum(1 for m in manifest if m['edits']),'need edits')
