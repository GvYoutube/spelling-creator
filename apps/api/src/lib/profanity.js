import { Filter } from 'glin-profanity';

// Shared profanity filter for moderating lesson comments. Built once (it compiles
// its word list into a regex) and reused across requests. `checkProfanity(text)`
// returns { containsProfanity, profaneWords }; we reject a comment outright when
// containsProfanity is true rather than censoring individual words.
export const profanityFilter = new Filter({
	languages: ['english', 'spanish', 'hindi'], // three most spoken languages
	detectLeetspeak: true,
	leetspeakLevel: 'moderate',
	normalizeUnicode: true,
	cacheResults: true,
	maxCacheSize: 1000,
});
