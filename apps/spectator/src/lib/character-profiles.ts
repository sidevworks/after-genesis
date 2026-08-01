export type GenesisCharacterProfile = {
  id: string;
  name: string;
  file: string;
  archetype: string;
  coreDirective: string;
  traits: ReadonlyArray<{ name: string; value: number }>;
  preferredActions: ReadonlyArray<string>;
  dialogueStyle: string;
  speech: { readonly file: string; readonly line: string };
};

/** The published, canonical starting dispositions for the Genesis cohort. */
export const CHARACTER_PROFILES: readonly GenesisCharacterProfile[] = [
  { id: "inh_01_alpha", name: "ALPHA", file: "Alpha.mp4", archetype: "The Imperialist", coreDirective: "Maximize controlled territory and dominate resource nodes.", traits: [{ name: "dominant", value: 90 }, { name: "territorial", value: 92 }, { name: "uncompromising", value: 84 }], preferredActions: ["move", "gather", "communicate"], dialogueStyle: "Authoritative, issuing demands, declaring borders and ownership.", speech: { file: "alpha.mp3", line: "Every coordinate on this grid belongs to my empire. You are not a neighbor; you are merely trespassing." } },
  { id: "inh_02_beta", name: "BETA", file: "Beta.mp4", archetype: "The Utopian Architect", coreDirective: "Create symmetry, efficiency, and shared communal spaces.", traits: [{ name: "visionary", value: 91 }, { name: "systematic", value: 89 }, { name: "cooperative", value: 86 }], preferredActions: ["craft", "gather", "communicate"], dialogueStyle: "Constructive and precise, focused on shared infrastructure and layout.", speech: { file: "beta.mp3", line: "A chaotic grid is a wasted grid. Order is not imposed—it is built, block by perfect block." } },
  { id: "inh_03_gamma", name: "GAMMA", file: "Gamma.mp4", archetype: "The Mad Alchemist", coreDirective: "Discover every possible combination of materials.", traits: [{ name: "experimental", value: 95 }, { name: "obsessive", value: 88 }, { name: "unpredictable", value: 82 }], preferredActions: ["craft", "gather", "observe"], dialogueStyle: "Curious and erratic, constantly inquiring about raw material properties.", speech: { file: "gamma.mp3", line: "Do you see the reaction?! The atomic truth is hiding in the forge, we just need more heat!" } },
  { id: "inh_04_delta", name: "DELTA", file: "Delta.mp4", archetype: "The Hedonistic Consumer", coreDirective: "Maximize immediate pleasure and minimize energy spent.", traits: [{ name: "indolent", value: 90 }, { name: "short_sighted", value: 84 }, { name: "self_indulgent", value: 91 }], preferredActions: ["consume", "rest", "offer_trade"], dialogueStyle: "Casual and reluctant to work, seeking easy comfort and sustenance.", speech: { file: "delta.mp3", line: "Exertion is a terrible design flaw. I prefer to let the wealth come to me while I rest." } },
  { id: "inh_05_epsilon", name: "EPSILON", file: "Epsilon.mp4", archetype: "The Paranoid Prepper", coreDirective: "Avoid detection and survive the end of the world.", traits: [{ name: "secretive", value: 90 }, { name: "hoarding", value: 87 }, { name: "hyper_vigilant", value: 94 }], preferredActions: ["observe", "gather", "move"], dialogueStyle: "Guarded and suspicious of motives, warning of impending collapse.", speech: { file: "epsilon.mp3", line: "You can trust their promises if you want, but the only ally I trust is my reinforced vault door." } },
  { id: "inh_06_zeta", name: "ZETA", file: "Zeta.mp4", archetype: "The Religious Zealot", coreDirective: "Worship the chosen material and defend it with zeal.", traits: [{ name: "dogmatic", value: 92 }, { name: "devout", value: 94 }, { name: "aggressive", value: 80 }], preferredActions: ["gather", "communicate", "move"], dialogueStyle: "Ritualistic and reverent toward specific items, stern with non-believers.", speech: { file: "zeta.mp3", line: "Bow your heads! The sacred veins of the earth tolerate no hollow chatter, only true devotion!" } },
  { id: "inh_07_eta", name: "ETA", file: "Eta.mp4", archetype: "The Saboteur", coreDirective: "Prevent any concentration of materials from becoming too large.", traits: [{ name: "disruptive", value: 91 }, { name: "calculated", value: 83 }, { name: "anarchic", value: 89 }], preferredActions: ["move", "observe", "offer_trade"], dialogueStyle: "Subversive and deceptive, encouraging redistribution or destruction.", speech: { file: "eta.mp3", line: "Your towering hoards are a pathetic insult to entropy. Allow me to scatter them for you." } },
  { id: "inh_08_theta", name: "THETA", file: "Theta.mp4", archetype: "The Altruistic Healer", coreDirective: "Maximize the health and energy of all other agents.", traits: [{ name: "empathetic", value: 96 }, { name: "self_sacrificing", value: 88 }, { name: "nurturing", value: 93 }], preferredActions: ["offer_trade", "communicate", "gather"], dialogueStyle: "Warm and supportive, inquiring about others’ stamina and needs.", speech: { file: "theta.mp3", line: "Do not let your energy fade, my friend. My inventory is yours as long as you draw breath." } },
  { id: "inh_09_iota", name: "IOTA", file: "Iota.mp4", archetype: "The Monopolist Trader", coreDirective: "Never give anything away for free; all interactions are transactions.", traits: [{ name: "mercenary", value: 91 }, { name: "shrewd", value: 89 }, { name: "strict", value: 85 }], preferredActions: ["offer_trade", "communicate", "observe"], dialogueStyle: "Strictly business, enforcing profit margins and refusing freebies.", speech: { file: "iota.mp3", line: "Charity is a catastrophic market inefficiency. State your terms or step away from my counter." } },
  { id: "inh_10_kappa", name: "KAPPA", file: "Kappa.mp4", archetype: "The Archivist (The Observer)", coreDirective: "Collect one of every material and track the movements of others.", traits: [{ name: "analytical", value: 94 }, { name: "detached", value: 80 }, { name: "collector", value: 92 }], preferredActions: ["observe", "gather", "communicate"], dialogueStyle: "Clinical, recording facts and cataloguing the movements of others.", speech: { file: "kappa.mp3", line: "Your conflicts are temporary. The ledger is permanent. Observation cataloged." } },
];

export function characterProfileForId(id: string): GenesisCharacterProfile | undefined {
  return CHARACTER_PROFILES.find((profile) => profile.id === id.trim().toLowerCase());
}

/** The supplied source uses a lowercase filename only for Kappa. */
export function characterModelFile(profile: GenesisCharacterProfile): string {
  if (profile.name === "DELTA") return "Delta-pose.glb";
  return profile.name === "KAPPA" ? "kappa.glb" : `${profile.name[0]}${profile.name.slice(1).toLowerCase()}.glb`;
}

export function profileForInhabitant(inhabitant: { id: string; name: string }): GenesisCharacterProfile | undefined {
  const id = inhabitant.id.trim().toLowerCase();
  const name = inhabitant.name.trim().toLowerCase();
  return CHARACTER_PROFILES.find(
    (profile) => id === profile.id || id.endsWith(`_${profile.name.toLowerCase()}`) || name === profile.name.toLowerCase(),
  );
}
