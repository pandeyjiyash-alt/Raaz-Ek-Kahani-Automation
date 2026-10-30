import type { ReviewProject } from './reviewState.js';

export function youtubeMetadata(project: ReviewProject) {
  const custom = (project.youtube_metadata ?? {}) as { title?: string; description?: string; tags?: string[] };
  const idea = (project.idea as any)?.selected;
  const base = project.review?.title || idea?.title || 'Hindi Horror Story';
  const title = custom.title || (base.includes('#Shorts') ? base : `${base} | Hindi Horror Story | RAAZ`).slice(0, 100);
  const hook = idea?.hook || `${base} — एक काल्पनिक हिंदी लोक-डरावनी कहानी, रहस्य और अनजाने डर से भरी।`;
  const description = project.review?.description || custom.description || `${base}\n\n${hook}\n\nइस Hindi horror story को अंत तक देखें और बताएं: ऐसी स्थिति में आप क्या करते?\n\nऐसी और हिंदी डरावनी कहानियों के लिए चैनल देखें और सब्सक्राइब करें:\nhttps://www.youtube.com/@raaz_ekkahani\n\nयह कहानी 100% काल्पनिक है। सभी पात्र और गाँव काल्पनिक हैं। वीडियो में AI की सहायता से बनाए गए दृश्य और आवाज़ें हैं।\n\n#HindiHorrorStory #HorrorStory #RaazEkKahani`;
  const candidates = custom.tags || [base, 'Hindi horror story', 'Hindi horror kahani', 'हिंदी डरावनी कहानी', 'Indian folk horror', 'animated horror story', 'horror stories in Hindi', 'Raaz ek kahani', 'raaz_ekkahani'];
  let used = 0;
  const tags = [...new Set(candidates)].filter(tag => { if (tag.length > 100 || used + tag.length + 1 > 500) return false; used += tag.length + 1; return true; });
  return { title, description: description.slice(0, 5000), tags };
}
