import json,sys
r=json.load(open(sys.argv[1])); S=r['samples']
def win(a,b): return [s for s in S if a<=s['t']<=b]
def avg(w): return sum(s['Y'] for s in w)/len(w)
base=avg(win(0.5,0.8)); w=win(1.0,1.9); pk=max(w,key=lambda s:s['Y']); post=avg(win(2.3,2.6))
ref=max(base,post); back=next((s for s in win(pk['t'],2.5) if s['Y']<=ref*1.10),None)
print(f"base {base:5.1f} peak {pk['Y']:5.1f} @+{(pk['t']-1)*1000:3.0f}ms ratio {pk['Y']/base:4.2f} back@+{(back['t']-1)*1000 if back else -1:4.0f}ms", end='')
if len(sys.argv)>2:
    wf=min(S,key=lambda s:abs(s['t']-4.1)); nx=min(S,key=lambda s:abs(s['t']-4.1-1/30)); pre=min(S,key=lambda s:abs(s['t']-4.1+1/30))
    print(f" | pre {pre['Y']:.0f} white {wf['Y']:.0f} next {nx['Y']:.0f} | swirlpk {max(s['Y'] for s in win(3.0,3.4)):.0f} | climb mean {avg(win(4.2,8.0)):.0f}")
else: print()
