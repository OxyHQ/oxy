#!/usr/bin/env python3
"""Produce reviewable copies; never edit consumer worktrees or dispatch Actions."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
BASE=ROOT/'docs/architecture/1519-consumer-rollout-preflight/execution'
OUT=BASE/'frontend-dispatch'
GATE=Path(__file__).with_name('verify-manual-frontend.py').read_bytes()
SPECS={'Clarity':('deploy.yml','deploy-frontend'),'Nilo':('deploy.yml','deploy-frontend'),
       'tnp':('deploy.yml','verify'),'website':('deploy.yml','deploy'),
       'Mention':('deploy-frontends.yml','scope'),'CrowdSource':('deploy-frontends.yml','scope')}
INPUTS='''  workflow_dispatch:
    inputs:
      expected_sha:
        description: Exact reviewed current main SHA
        required: true
        type: string
      ci_run_id:
        description: Successful push CI run for this exact main SHA
        required: true
        type: string
'''


def gate_step(repo,indent=6):
    workflow='checks.yml' if repo=='website' else 'ci.yml'
    s='''- name: Verify manual release source and CI
  if: github.event_name == 'workflow_dispatch'
  env:
    GH_TOKEN: ${{ github.token }}
    EXPECTED_SHA: ${{ inputs.expected_sha }}
    EXPECTED_CI_RUN_ID: ${{ inputs.ci_run_id }}
    EXPECTED_CI_WORKFLOW: .github/workflows/CI_PATH
    OXY_1519_ROLLOUT_HOLD: ${{ vars.OXY_1519_ROLLOUT_HOLD }}
  run: python3 .github/scripts/verify-manual-frontend.py
'''.replace('CI_PATH',workflow)
    return '\n'.join(' '*indent+line if line else '' for line in s.splitlines())+'\n'


def prepare():
    result=[]
    for row in json.loads((BASE/'lots.json').read_text())['consumers']:
        repo=row['repository'].split('/')[-1]
        if repo not in SPECS:continue
        name,job=SPECS[repo]; source=Path(row['worktree'])/'.github/workflows'/name
        before=source.read_text(); s=before.replace('on:\n','on:\n'+INPUTS,1)
        if repo in ('Mention','CrowdSource'):
            s=s.replace("DEPLOY_SHA: ${{ github.event_name == 'push' && github.sha || github.event.workflow_run.head_sha }}",
                        "DEPLOY_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}")
            s=s.replace('DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}',
                        "DEPLOY_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}")
            start=s.index('    if: >-\n',s.index('  scope:\n')); end=s.index('    runs-on:',start)
            old=s[start+len('    if: >-\n'):end].strip()
            s=s[:start]+"    if: >-\n      vars.OXY_1519_ROLLOUT_HOLD != 'true' &&\n      ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||\n       ("+old+"))\n"+s[end:]
            if repo=='CrowdSource':
                s=s.replace('  scope:\n','  scope:\n    permissions:\n      contents: read\n      actions: read\n',1)
            # Insert after scope checkout block, preserving fetch-depth/tags.
            pos=s.index('      - name:',s.index('    steps:',s.index('  scope:')))
            s=s[:pos]+gate_step(repo)+'\n'+s[pos:]
            if repo=='Mention':
                s=s.replace('        run: bash .github/scripts/release-provenance.sh','''        run: |
          if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
            # The preceding exact-main CI gate authorizes this explicit retry.
            echo 'release=true' >> "$GITHUB_OUTPUT"
          else
            bash .github/scripts/release-provenance.sh
          fi''',1)
        else:
            # The manual gate is before install/build and all original verification remains.
            anchor='  '+job+':\n'
            s=s.replace(anchor,anchor+"    if: github.ref == 'refs/heads/main' && vars.OXY_1519_ROLLOUT_HOLD != 'true'\n",1)
            if repo=='tnp':
                s=s.replace('      contents: read\n','      contents: read\n      actions: read\n',1)
                s=s.replace('  deploy:\n','  deploy:\n    if: github.ref == \'refs/heads/main\' && vars.OXY_1519_ROLLOUT_HOLD != \'true\'\n',1)
                # Recheck immediately before effect in deploy job also needs actions:read.
                s=s.replace('      deployments: write\n','      deployments: write\n      actions: read\n',1)
            elif repo=='website': s=s.replace('      deployments: write\n','      deployments: write\n      actions: read\n',1)
            else: s=s.replace(anchor,anchor+'    permissions:\n      contents: read\n      actions: read\n',1)
            pos=s.index('\n\n',s.index('      - uses: actions/checkout'))
            s=s[:pos]+'\n\n'+gate_step(repo).rstrip()+s[pos:]
        if repo in ('Mention','CrowdSource'):
            s=s.replace("    if: needs.scope.outputs.", "    if: vars.OXY_1519_ROLLOUT_HOLD != 'true' && needs.scope.outputs.")
        # Main may advance during a long build: recheck manual proof before each effect.
        if repo in ('Clarity','Nilo'):
            marker='      - name: Deploy the Worker\n'
        elif repo=='website': marker='      - run: bunx wrangler@4 pages deploy'
        elif repo=='tnp': marker='      - name: Deploy to Cloudflare Pages\n'
        else: marker=None  # Existing require-current-main.sh repeats before each deployment.
        if marker:
            pos=s.index(marker); s=s[:pos]+gate_step(repo)+'\n'+s[pos:]
        target=OUT/repo/'.github/workflows'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(s)
        helper=OUT/repo/'.github/scripts/verify-manual-frontend.py';helper.parent.mkdir(parents=True,exist_ok=True);helper.write_bytes(GATE)
        result.append({'repository':row['repository'],'sourceHead':row['preparedHead'],
                       'workflow':'.github/workflows/'+name,'beforeSha256':hashlib.sha256(before.encode()).hexdigest(),
                       'afterSha256':hashlib.sha256(s.encode()).hexdigest(),'helperSha256':hashlib.sha256(GATE).hexdigest(),
                       'template':str(target.relative_to(ROOT)),'helper':str(helper.relative_to(ROOT)),
                       'ciWorkflow':'.github/workflows/'+('checks.yml' if repo=='website' else 'ci.yml')})
    (OUT/'manifest.json').write_text(json.dumps({'status':'prepared; not applied or dispatched','rows':result},indent=2)+'\n')
    print(f'Prepared {len(result)} frontend workflow copies; no consumer edits')

if __name__=='__main__':prepare()
