export const LANGUAGES = [
  { code: 'auto', name: 'Auto-detect', aliases: ['automatic', 'detect'] },
  { code: 'en', name: 'English', aliases: ['eng', 'english'] },
  { code: 'zh', name: 'Chinese', aliases: ['ch', 'chinese', '中文', 'mandarin', 'cn'] },
  { code: 'ja', name: 'Japanese', aliases: ['jp', 'japanese', '日本語'] },
  { code: 'ko', name: 'Korean', aliases: ['kr', 'korean', '한국어'] },
  { code: 'fr', name: 'French', aliases: ['french', 'français'] },
  { code: 'de', name: 'German', aliases: ['german', 'deutsch'] },
  { code: 'es', name: 'Spanish', aliases: ['spanish', 'español'] },
  { code: 'ru', name: 'Russian', aliases: ['russian', 'русский'] },
  { code: 'pt', name: 'Portuguese', aliases: ['portuguese', 'português'] },
  { code: 'it', name: 'Italian', aliases: ['italian', 'italiano'] },
  { code: 'ar', name: 'Arabic', aliases: ['arabic', 'العربية'] },
  { code: 'nl', name: 'Dutch', aliases: ['dutch', 'nederlands'] },
  { code: 'hi', name: 'Hindi', aliases: ['hindi', 'हिन्दी'] },
  { code: 'th', name: 'Thai', aliases: ['thai', 'ไทย'] },
  { code: 'vi', name: 'Vietnamese', aliases: ['vietnamese', 'tiếng việt', 'tieng viet'] },
  { code: 'sv', name: 'Swedish', aliases: ['swedish', 'svenska'] },
  { code: 'tr', name: 'Turkish', aliases: ['turkish', 'türkçe'] },
  { code: 'pl', name: 'Polish', aliases: ['polish', 'polski'] },
  { code: 'uk', name: 'Ukrainian', aliases: ['ukrainian', 'українська'] },
  { code: 'fi', name: 'Finnish', aliases: ['finnish', 'suomi'] },
  { code: 'no', name: 'Norwegian', aliases: ['norwegian', 'norsk'] },
  { code: 'da', name: 'Danish', aliases: ['danish', 'dansk'] },
  { code: 'cs', name: 'Czech', aliases: ['czech', 'čeština'] },
  { code: 'el', name: 'Greek', aliases: ['greek', 'ελληνικά'] },
  { code: 'he', name: 'Hebrew', aliases: ['hebrew', 'עברית'] },
  { code: 'hu', name: 'Hungarian', aliases: ['hungarian', 'magyar'] },
  { code: 'ro', name: 'Romanian', aliases: ['romanian', 'română'] },
  { code: 'id', name: 'Indonesian', aliases: ['indonesian', 'bahasa', 'bahasa indonesia'] },
  { code: 'ms', name: 'Malay', aliases: ['malay', 'malaysian', 'bahasa melayu', 'bahasa malaysia'] },
  { code: 'tl', name: 'Filipino', aliases: ['filipino', 'tagalog'] },
  { code: 'bn', name: 'Bengali', aliases: ['bengali', 'বাংলা'] },
  { code: 'fa', name: 'Persian', aliases: ['persian', 'farsi', 'فارسی'] },
  { code: 'ta', name: 'Tamil', aliases: ['tamil', 'தமிழ்'] },
  { code: 'te', name: 'Telugu', aliases: ['telugu', 'తెలుగు'] },
  { code: 'ur', name: 'Urdu', aliases: ['urdu', 'اردو'] },
  { code: 'sw', name: 'Swahili', aliases: ['swahili', 'kiswahili'] },
  { code: 'bg', name: 'Bulgarian', aliases: ['bulgarian', 'български'] },
  { code: 'sk', name: 'Slovak', aliases: ['slovak', 'slovenčina'] },
  { code: 'lt', name: 'Lithuanian', aliases: ['lithuanian', 'lietuvių'] },
  { code: 'lv', name: 'Latvian', aliases: ['latvian', 'latviešu'] },
  { code: 'et', name: 'Estonian', aliases: ['estonian', 'eesti'] },
];

export function searchLanguages(query) {
  if (!query) return [...LANGUAGES];
  const q = query.toLowerCase();
  const scored = [];
  for (const lang of LANGUAGES) {
    let score = 99;
    if (lang.code === q) score = 0;
    else if (lang.code.startsWith(q)) score = 1;
    else if (lang.name.toLowerCase().startsWith(q)) score = 2;
    else if (lang.aliases.some(a => a.toLowerCase().startsWith(q))) score = 3;
    else if (lang.name.toLowerCase().includes(q)) score = 4;
    else if (lang.aliases.some(a => a.toLowerCase().includes(q))) score = 5;
    else continue;
    scored.push({ ...lang, _score: score });
  }
  scored.sort((a, b) => a._score - b._score || a.code.localeCompare(b.code));
  return scored.map(({ _score, ...lang }) => lang);
}

export function findUniqueMatch(query) {
  const results = searchLanguages(query);
  return results.length === 1 ? results[0] : null;
}
