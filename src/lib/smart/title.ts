/**
 * Turns what is left of a request, once its scheduling details are removed,
 * into a short task title: the activity as an action ("Repairing Mineh's
 * phone" → "Repair Mineh's Phone"), without lead-ins ("I need to", "remind me
 * to"), filler or needless articles, consistently capitalised. Names,
 * acronyms and other context are kept as written.
 */

const LEADS: RegExp[] = [
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:schedule|plan|add|create|book|set up|put|arrange|organi[sz]e)\s+(?:(?:a|an|the|some)\s+)?(?:(?:task|time|slot|block|session)\s+)?(?:(?:to|for)\s+)?/i,
  /^(?:a\s+|an\s+|some\s+)?(?:session|block|slot|time)\s+(?:to|for)\s+/i,
  /^(?:please\s+)?(?:remind me to|remember to|don'?t forget to|make sure (?:i|to))\s+/i,
  /^(?:and\s+|then\s+|also\s+|and then\s+|and also\s+)+/i,
  /^(?:i|we)(?:\s+(?:really|also|still|just))?\s+(?:need|have|want|ought|would like|'d like|wish|plan|intend|am going|'m going|are going|'re going)\s+to\s+/i,
  /^(?:i|we)\s+(?:must|should|will|shall|can|gotta|wanna)\s+/i,
  /^(?:i'?ll|we'?ll|let me|let'?s|time to|need to|have to|got to|going to)\s+/i,
];

/** Verbs that lose a final "e" before "-ing": "making" → "make". */
const E_VERBS = new Set(
  ("mak writ updat prepar complet schedul organiz organis arrang creat mov remov replac chang manag practic practis exercis driv rid bak tak giv sav shar compil analyz analys configur restor releas clos us finaliz finalis revis typ fil hir invit celebrat translat calculat negotiat upgrad migrat investigat propos compos purchas renovat decorat serv solv improv resolv escalat delet smok styl " +
    "automat generat integrat validat evaluat estimat duplicat consolidat coordinat iterat illustrat simulat formulat populat regulat renegotiat terminat nominat donat notat rotat locat relocat allocat dedicat educat communicat indicat publicat certificat medicat ventilat lubricat calibrat " +
    "cod decod encod trad upgrad grad shad wad pac trac fac plac spac danc financ balanc enforc reduc produc introduc servic notic invoic pric slic splic sourc outsourc resourc " +
    "judg merg charg chang exchang rang arrang challeng packag messag engag damag stag forg " +
    "tim nam fram blam tam sum resum assum consum " +
    "tun refin defin combin examin determin imagin outlin streamlin onlin min shin pin din lin " +
    "wip shap scrap tap typ hop cop scop " +
    "car shar prepar compar declar squar stor restor explor ignor scor secur measur captur structur featur figur insur ensur assur cur wir hir fir retir requir acquir inquir enquir admir inspir " +
    "bas cas eras chas purchas phras rais prais reus refus excus clos disclos expos propos suppos oppos compos dispos advis revis supervis rais nois promis " +
    "writ rewrit quot not vot promot delet complet compet execut contribut distribut attribut comput commut disput " +
    "leav sav wav shav pav hav giv forgiv liv driv arriv thriv receiv achiev believ retriev reliev mov remov improv approv prov sol")
    .split(/\s+/)
    .filter(Boolean),
);
/** "-ing" words that are things, not actions, at the start of a title. */
const ING_NOUNS = new Set(["remaining", "upcoming", "outstanding", "pending", "missing", "existing", "following", "coming", "ongoing", "incoming", "outgoing", "morning", "meeting", "training", "briefing", "wedding", "building", "morning", "evening", "spring", "string", "thing", "king", "ring", "wing", "bring", "sing", "ping", "hearing", "opening", "screening", "onboarding", "boxing", "banking", "marketing", "accounting", "engineering", "housing", "painting", "booking", "funding", "pricing", "branding", "ceiling", "sibling", "darling", "viking", "bing"]);
/** After a leading "-ing" word, these mean it names an event ("Planning session"), not an action. */
const EVENT_NOUNS = new Set(["session", "meeting", "class", "workshop", "course", "day", "team", "department", "call", "lesson", "seminar", "committee", "group"]);
/** "Work on the … dashboard" means improving something that is being built. */
const BUILDABLE = new Set(["dashboard", "app", "application", "site", "website", "page", "project", "design", "code", "codebase", "feature", "features", "ui", "ux", "interface", "layout", "prototype", "model", "system", "platform", "tool", "script", "module", "plugin", "api", "backend", "frontend", "game", "bot", "portfolio", "product", "build", "theme", "template"]);
const VERB_SYNONYMS: Record<string, string> = { finish: "complete", finalise: "finalize", wrap: "wrap" };
const SMALL = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "at", "by", "from", "vs", "via", "into", "as"]);
const MAX_WORDS = 9;

/** "repairing" → "repair", "running" → "run", "writing" → "write". */
export function baseVerb(gerund: string): string {
  const w = gerund.toLowerCase();
  if (!w.endsWith("ing") || w.length < 5) return gerund;
  let stem = w.slice(0, -3);
  if (stem.endsWith("y") || /[aeiou]{2}[^aeiou]$/.test(stem)) return stem; // studying, repairing, cleaning
  if (/([bgmnprt])\1$/.test(stem)) return stem.slice(0, -1); // running, planning, getting, shipping
  if (E_VERBS.has(stem)) stem += "e"; // making, writing, updating
  return stem;
}

function capitalise(word: string, first: boolean): string {
  if (!word) return word;
  // keep words that already carry their own capitals: NEXUS, CV, iPhone, Mineh's
  if (/[A-Z]/.test(word.slice(1)) || (/^[A-Z]/.test(word) && !first && word.length > 1 && !SMALL.has(word.toLowerCase()))) return word;
  if (!first && SMALL.has(word.toLowerCase())) return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1);
}

export function generateTitle(raw: string): string {
  let t = raw
    .replace(/[“”"]/g, "")
    .replace(/\s*[,;]+\s*/g, " ")
    .replace(/\b(?:preferably|ideally|if possible|sometime|some time|please|probably|maybe|hopefully|kindly|just)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) for (const lead of LEADS) t = t.replace(lead, "");
  // prepositions left hanging once the time phrases are gone
  for (let i = 0; i < 4; i++) {
    t = t
      .replace(/\s+(?:in|on|at|by|for|during|the|and|around|about|from|to|this|of|it should take|should take|it takes|takes|taking|every|each|until|till|before|after)$/i, "")
      .replace(/^(?:in|on|at|and|the|to|for)\s+(?=(?:in|on|at|the)\b)/i, "")
      .trim();
  }
  t = t.replace(/[\s.,;:!?-]+$/g, "").replace(/^[\s.,;:!?-]+/g, "");
  let words = t.split(" ").filter(Boolean);
  if (!words.length) return "";
  if (/^(?:the|a|an)$/i.test(words[0]) && words.length > 1) words = words.slice(1);

  // "attend a Zoom meeting" is the meeting; "go to the gym" is the gym
  if (words.length > 1 && /^(?:attend|join|have|do)$/i.test(words[0]) && /^(?:a|an|the|my)$/i.test(words[1])) words = words.slice(2);
  else if (words.length > 2 && /^(?:go|head|get)$/i.test(words[0]) && /^to$/i.test(words[1])) words = words.slice(/^(?:the|a|an|my)$/i.test(words[2]) && words.length > 3 ? 3 : 2);
  // "finish reviewing the report" is about reviewing it
  if (words.length > 1 && /^(?:finish|complete|continue|start|begin|keep)$/i.test(words[0]) && /^[a-z]{3,}ing$/i.test(words[1]) && !ING_NOUNS.has(words[1].toLowerCase())) words = words.slice(1);
  // a possessive in front adds nothing: "my gym session" → "Gym Session"
  if (words.length > 2 && /^my$/i.test(words[0])) words = words.slice(1);
  if (!words.length) return "";

  // the activity as an action: "Repairing …" → "Repair …"
  const first = words[0].toLowerCase();
  let isVerb = false;
  if (first.endsWith("ing") && first.length >= 5 && !ING_NOUNS.has(first) && !EVENT_NOUNS.has((words[1] ?? "").toLowerCase())) {
    words[0] = baseVerb(first);
    isVerb = true;
  }
  const verb = words[0].toLowerCase();
  if (VERB_SYNONYMS[verb]) words[0] = VERB_SYNONYMS[verb];
  // "work on the NEXUS dashboard" → "Improve NEXUS Dashboard"
  if (verb === "work" && words[1]?.toLowerCase() === "on" && words.length > 2) {
    const object = words.slice(2);
    const last = object[object.length - 1].toLowerCase().replace(/[^a-z]/g, "");
    words = BUILDABLE.has(last) ? ["improve", ...object] : words;
    isVerb = true;
  }
  // an article straight after the action reads better dropped: "Call the client" → "Call Client"
  const at = words[0].toLowerCase() === "work" && words[1]?.toLowerCase() === "on" ? 2 : 1;
  if (words.length > at + 1 && /^(?:the|a|an)$/i.test(words[at])) words.splice(at, 1);
  // "my" is kept where the title would be too bare without it ("Update My CV"), dropped before a longer object
  else if (words.length > at + 2 && /^my$/i.test(words[at]) && (isVerb || /^[a-z]/.test(words[0]))) words.splice(at, 1);

  // keep it short: stop at a new clause, then at a word limit
  const clause = words.findIndex((w, i) => i >= 2 && /^(?:because|so|then|since|although|while|which|that)$/i.test(w));
  if (clause > 0) words = words.slice(0, clause);
  if (words.length > MAX_WORDS) words = words.slice(0, MAX_WORDS);
  while (words.length > 1 && SMALL.has(words[words.length - 1].toLowerCase())) words.pop();

  return words.map((w, i) => capitalise(w, i === 0)).join(" ");
}
