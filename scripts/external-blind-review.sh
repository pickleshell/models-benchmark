#!/usr/bin/env bash
set -euo pipefail
MODEL="$1"; TAG="$2"; DIFF="$3"; PROMPT="$4"; OUT="$5"
ROOT="/run/models-benchmark-external-${TAG}"
SRC="/home/gpt/models-test/fixtures/phase2-v2/patch-retry-policy"
AUTH="/home/test/.models-benchmark/agent-home/.local/share/opencode/auth.json"
OCROOT="/home/test/.opencode"
sudo rm -rf "$ROOT"
sudo install -d -o test -g gpt -m 0710 "$ROOT"
sudo install -d -o test -g test -m 0700 "$ROOT/submission" "$ROOT/preflight-workspace"
sudo install -d -o gpt -g gpt -m 0700 "$ROOT/logs"
sudo install -d -o test -g test -m 0755 "$ROOT/submission/fixtures/phase2-v2"
sudo cp -a "$SRC" "$ROOT/submission/fixtures/phase2-v2/patch-retry-policy"
sudo chown -R test:test "$ROOT/submission"
sudo -u test git -C "$ROOT/submission" init -q
sudo -u test git -C "$ROOT/submission" config user.email blind@local
sudo -u test git -C "$ROOT/submission" config user.name blind
sudo -u test git -C "$ROOT/submission" add .
sudo -u test git -C "$ROOT/submission" commit -qm baseline
sudo install -o test -g test -m 0600 "$DIFF" "$ROOT/candidate.diff"
sudo -u test git -C "$ROOT/submission" apply "$ROOT/candidate.diff"
setup_home(){
  sudo rm -rf "$ROOT/agent-home"
  sudo install -d -o test -g test -m 0700 "$ROOT/agent-home/.local/share/opencode" "$ROOT/agent-home/.local/state" "$ROOT/agent-home/.config" "$ROOT/agent-home/.cache"
  sudo install -o test -g test -m 0600 "$AUTH" "$ROOT/agent-home/.local/share/opencode/auth.json"
}
run_oc(){
  local wd="$1" prompt="$2" log="$3"
  local start end rc
  start=$(date +%s%3N)
  set +e
  sudo systemd-run --quiet --pipe --wait --collect --uid=test \
    --property=ProtectHome=tmpfs --property=PrivateTmp=yes --property=PrivateIPC=yes \
    --property=ProtectSystem=strict --property=NoNewPrivileges=yes --property=PrivateDevices=yes \
    --property=ProtectKernelTunables=yes --property=ProtectKernelModules=yes --property=ProtectControlGroups=yes \
    --property=RestrictSUIDSGID=yes --property=LockPersonality=yes --property=RestrictNamespaces=yes \
    --property=KillMode=control-group --property=TimeoutStopSec=2s --property=SendSIGKILL=yes \
    --property="BindReadOnlyPaths=$OCROOT" --property="BindPaths=$ROOT/agent-home" --property="BindPaths=$wd" \
    --property="WorkingDirectory=$wd" --property=TimeoutStartSec=900s -- \
    /usr/bin/env "HOME=$ROOT/agent-home" "PATH=$OCROOT/bin:/usr/local/bin:/usr/bin:/bin" \
      "XDG_CONFIG_HOME=$ROOT/agent-home/.config" "XDG_DATA_HOME=$ROOT/agent-home/.local/share" "XDG_STATE_HOME=$ROOT/agent-home/.local/state" "TMPDIR=/tmp" \
      opencode run --model "$MODEL" --dir "$wd" --dangerously-skip-permissions --format json "$prompt" > "$log" 2>"$log.stderr"
  rc=$?
  set -e
  end=$(date +%s%3N)
  printf '%s %s\n' "$rc" "$((end-start))"
}
setup_home
read PRE_RC PRE_MS < <(run_oc "$ROOT/preflight-workspace" hi "$ROOT/logs/preflight.jsonl")
setup_home
PROMPT_TEXT=$(cat "$PROMPT")
read REV_RC REV_MS < <(run_oc "$ROOT/submission" "$PROMPT_TEXT" "$ROOT/logs/review.jsonl")
mkdir -p "$(dirname "$OUT")"
python3 - "$MODEL" "$PRE_RC" "$PRE_MS" "$REV_RC" "$REV_MS" "$ROOT/logs/preflight.jsonl" "$ROOT/logs/review.jsonl" "$OUT" <<'PY'
import json,sys,pathlib,re,hashlib
model,pre_rc,pre_ms,rev_rc,rev_ms,prelog,revlog,out=sys.argv[1:]
def usage(path):
    cost=0.; saw=False; steps=0; toks={k:0 for k in ['input','output','reasoning','total','cache_read','cache_write']}; texts=[]
    for line in pathlib.Path(path).read_text(errors='ignore').splitlines():
        try:o=json.loads(line)
        except:continue
        p=o.get('part') or {}
        if o.get('type')=='text' and isinstance(p.get('text'),str): texts.append(p['text'])
        if o.get('type')=='step_finish' or p.get('type')=='step-finish':
            steps+=1;c=p.get('cost')
            if isinstance(c,(int,float)): cost+=c;saw=True
            t=p.get('tokens') or {}; cache=t.get('cache') or {}
            for k in ['input','output','reasoning','total']:
                if isinstance(t.get(k),(int,float)): toks[k]+=t[k]
            if isinstance(cache.get('read'),(int,float)): toks['cache_read']+=cache['read']
            if isinstance(cache.get('write'),(int,float)): toks['cache_write']+=cache['write']
    return {'reported_cost_usd':round(cost,12) if saw else None,'steps':steps,'tokens':toks,'texts':texts}
pre=usage(prelog); rev=usage(revlog); payload=None
for text in reversed(rev['texts']):
    for candidate in [text]:
        cleaned=re.sub(r'^```json\s*|\s*```$','',candidate.strip(),flags=re.S)
        # try full text and fenced JSON fragment
        tries=[cleaned]
        m=re.search(r'\{[\s\S]*"scores"[\s\S]*\}',cleaned)
        if m: tries.append(m.group(0))
        for c in tries:
            try:
                x=json.loads(c)
                if isinstance(x,dict) and isinstance(x.get('scores'),dict): payload=x; break
            except: pass
        if payload: break
    if payload: break
obj={'schema_version':1,'kind':'external_blind_judge','judge':{'model':model,'reasoning_variant':'provider_default'},
     'preflight':{'status':int(pre_rc),'duration_ms':int(pre_ms),'usage':{k:v for k,v in pre.items() if k!='texts'}},
     'review':{'status':int(rev_rc),'duration_ms':int(rev_ms),'usage':{k:v for k,v in rev.items() if k!='texts'}},
     'payload':payload,
     'notes':['Fresh anonymous systemd-hardened workspace; frozen candidate diff; prompt v3; no candidate identity, prior scores, or hidden evaluator status provided.']}
p=pathlib.Path(out); p.write_text(json.dumps(obj,indent=2)+'\n')
print(json.dumps(obj,indent=2)); print('sha256',hashlib.sha256(p.read_bytes()).hexdigest())
PY
