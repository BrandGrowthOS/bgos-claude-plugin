import re,sys
def parse(path):
    out={}; cur={}; 
    text=open(path,errors='replace').read().splitlines()
    # blocks end with the PASS/FAIL line; tallies precede it
    tally=dict(p=0,f=0,s=0)
    for raw in text:
        line=re.sub(r'^\S*\s*\S*Z ','',raw) if re.match(r'^(.*\t)?\d{4}-\d\d-\d\dT',raw) else raw
        line=re.sub(r'^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ','',line)
        m=re.match(r'^# (pass|fail|cancelled|skipped) (\d+)\s*$',line)
        if m:
            k={'pass':'p','fail':'f','cancelled':'f','skipped':'s'}[m[1]]; tally[k]+=int(m[2]); continue
        m=re.match(r'^\s*(\d+) (pass|fail|skip)\s*$',line)
        if m:
            k={'pass':'p','fail':'f','skip':'s'}[m[2]]; tally[k]+=int(m[1]); continue
        m=re.match(r'^\[run-tests\] (PASS|FAIL) (\S+) \(',line)
        if m:
            out[m[2].replace('\\','/')]=(m[1],tally['p'],tally['f'],tally['s']); tally=dict(p=0,f=0,s=0)
    return out
a=parse(sys.argv[1]); b=parse(sys.argv[2])
print('mac files',len(a),'win files',len(b))
print('mac totals',[sum(v[i] for v in a.values()) for i in (1,2,3)],'win totals',[sum(v[i] for v in b.values()) for i in (1,2,3)])
print('only on one side:',sorted(set(a)^set(b))[:20])
diff=[]
for f in sorted(set(a)&set(b)):
    ma=a[f]; wi=b[f]
    if ma[1]+ma[2]+ma[3]!=wi[1]+wi[2]+wi[3]: diff.append((f,ma[1:],wi[1:]))
print('files with a different test COUNT (pass, fail, skip), mac then win:',len(diff))
for d in diff: print(' ',d)
sk=[(f,a[f][3],b[f][3]) for f in sorted(set(a)&set(b)) if a[f][3]!=b[f][3]]
print('files with different skip counts:',len(sk))
print('win FAIL lines:',[f for f,v in b.items() if v[0]=='FAIL'])
