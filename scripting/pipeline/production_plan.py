"""One auditable planning call before Flow credits; never invent audio measurements."""
from pathlib import Path
import argparse,json,hashlib
from .anthropic_client import ScriptClient
from .one_minute import json_object
from .models import save

def prepare(project_file):
 file=Path(project_file);p=json.loads(file.read_text(encoding='utf-8'));script=p['script']['raw_text'];root=Path(__file__).resolve().parents[2]
 prior=[]
 ledger=root/'production/output/story-library/story-ledger.json'
 if ledger.exists():
  for story in json.loads(ledger.read_text(encoding='utf-8'))['stories']:
   if story.get('status','').startswith(('published','scheduled','produced')):prior.append({k:story.get(k)for k in ['number','title','premise','twist']})
 prompt=(root/'production/prompts/production-contract.md').read_text(encoding='utf-8')
 request=prompt+'''\nYou are auditing the complete locked screenplay and making a production plan. Do not rewrite or shorten it. Return ONLY JSON:
{"story_quality_check":{"pass":true,"opening":"detailed assessment","continuity":"detailed assessment","climax":"detailed assessment","ending":"detailed assessment","source_dialogue_coverage":"assessment against scene lines","uniqueness":"specific comparison with prior premises/twists","issues":[]},
"voice_roles":{"@CHAR-01-NAME":"young_woman|old_woman|man|child|ghost"},
"production_plan":{"keyword":"Hindi search phrase matching this story","variants":["...","..."],"title":"Hindi title/hook including keyword, <=100 chars","thumbnail_hook":"2-4 Hindi words, no ending spoiler","thumbnail_scene":1,"summary":"2-3 spoiler-free natural Hindi lines","short_narration":"<=28 Devanagari words: story-specific suspense hook, fiction/story note and watch-full CTA","short_dialogue_scene":2,"short_scenes":[1,2,3],"short_title_hook":"short Hindi hook/keyword, <=22 characters","music_scene_boundaries":[5,10],"sound_events":[{"cue":"sting|bell|creak|footsteps|heartbeat|whisper|wind|scream|fire","scene":1,"offset_s":0,"duration_s":2,"target_lufs":-23}],"scary_scenes":[1]}}
Use actual scene IDs only. The Short uses three finished suspense scenes before the resolution, and one COMPLETE short dialogue line from short_dialogue_scene (at most ~8 seconds) plus the teaser narration. Do not expose the resolution or arbitrary unrelated slice. No invented dialogue for the original scenes. Sound events must include at least 8 distinct matching cues, every scary event and the first scene. Music boundaries must be ordered, inside the real scene sequence, around rising tension and the resolved outro. The opening, supernatural rules, motivation, climax, rescue/outcome and final fiction note must be coherent. A changed title alone is not uniqueness. Fail with specific issues if any material ambiguity, duplicate premise/twist, dropped words or contradiction exists.
'''
 payload={'script':script,'source_script':p['script'].get('source_text'),'characters':p['characters'],'scenes':p['scenes'],'previous_stories':prior};result=json_object(ScriptClient().complete(request+'\nINPUT:\n'+json.dumps(payload,ensure_ascii=False),max_tokens=6500))
 audit=result['story_quality_check'];audit['script_sha256']=hashlib.sha256(script.encode()).hexdigest();p['story_quality_check']=audit;save(file,p)
 if not audit.get('pass')or audit.get('issues'):raise ValueError('Story audit failed before credits: '+json.dumps(audit,ensure_ascii=False))
 for c in p['characters']:c['voice_role']=result['voice_roles'][c['tag']]
 plan=result['production_plan'];ids={int(s['scene_number'])for s in p['scenes']}
 if any(int(n)not in ids for n in [plan['thumbnail_scene'],plan['short_dialogue_scene'],*plan['short_scenes'],*plan['music_scene_boundaries']]):raise ValueError('Plan references a missing scene')
 if len(plan['thumbnail_hook'].split())not in [2,3,4] or len(plan['short_narration'].split())>28:raise ValueError('Thumbnail/teaser prompt violated length contract')
 if len({e['cue']for e in plan['sound_events']})<8:raise ValueError('At least eight distinct matching SFX cues required')
 if any(n not in {int(e['scene'])for e in plan['sound_events']}for n in plan['scary_scenes']):raise ValueError('Scary event missing SFX')
 p['production_plan']=plan;save(file,p);return file
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--project',required=True);args=parser.parse_args();print(prepare(args.project))
