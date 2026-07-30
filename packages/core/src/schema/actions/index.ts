/**
 * The action catalogue (§13, §11I).
 *
 * Sixty actions: the thirty-six of §13's minimum vocabulary and the twenty-four
 * of §11I. This file binds each one to its payload schema and to the static
 * metadata §11A demands of every action — start conditions, expected duration,
 * participants, location, resource requirements, whether interruption is
 * permitted, completion conditions and the result of interruption.
 *
 * CONSTITUTIONAL (§13): "Adding an action after Genesis constitutes a
 * constitutional change and therefore requires a new world unless the original
 * constitution explicitly contains a disclosed extension mechanism." The
 * catalogue is frozen at Genesis. `ACTION_TYPES` in `../action-spec.js` is the
 * authority on membership; the exhaustiveness test in `./index.test.ts` fails
 * the build if this file and that list ever disagree.
 *
 * ## How the numbers were chosen
 *
 * `baseDuration` is the scarcity mechanism of the whole simulation (§11A: "Time
 * and attention are scarce canonical resources"). An inhabitant has roughly 960
 * waking minutes a day, so a duration is best read as a fraction of a day:
 * `rest` takes most of one, `gather` a fifth, `communicate` a thirtieth, and
 * `create_inhabitant` three whole days during which its creator does nothing
 * else.
 *
 * `baseCost` is charged on *attempt*, not on success. An action that fails its
 * roll still consumed the effort. Costs are deliberately denominated in `energy`
 * and `compute` wherever the action is speech, thought or writing, and in
 * material resources only where matter is actually consumed — this is what makes
 * the confinement rules below fall out of physics rather than out of a list.
 *
 * ## Confinement (§11H)
 *
 * `allowedWhileConfined` is true exactly when an action can be completed using
 * only the actor's own body, speech, thought and writing, in the place it is
 * already in. §11H's restricted list — leaving a location, ordinary employment,
 * gathering resources, accessing property, attending organisations, creating
 * another inhabitant — maps onto the false cases; its retained list — converse,
 * think, write, create limited artifacts, negotiate, receive visitors, appeal,
 * refuse cooperation, attempt escape — maps onto the true ones.
 *
 * Where the two lists left a genuine choice, it was resolved towards §11J's
 * requirement that "A confined inhabitant remains historically and cognitively
 * intact". A confined inhabitant may still vote, found an organisation, accuse
 * its captors and publish. Whether anyone *counts* the vote or reads the
 * publication is a question for the other inhabitants, and the engine declines
 * to answer it on their behalf (§11G).
 */
import { z } from "zod";
import type {
  ActionCatalogue,
  ActionSpec,
  ActionType,
} from "../action-spec.js";
import { days, hours, minutes } from "../../time.js";
import { MATURITY } from "./common.js";

import { InterruptActivityPayloadSchema, CareForDependantPayloadSchema, SupervisePayloadSchema } from "./care.js";
import { AnnouncePayloadSchema, CommunicatePayloadSchema } from "./communication.js";
import { BuildPayloadSchema, CraftPayloadSchema } from "./construction.js";
import {
  AcceptContractPayloadSchema,
  OfferContractPayloadSchema,
  PerformContractPayloadSchema,
  RejectContractPayloadSchema,
  TerminateContractPayloadSchema,
} from "./contracts.js";
import { CreateCurrencyPayloadSchema, TransferCurrencyPayloadSchema } from "./currency.js";
import {
  ApplyTreatmentPayloadSchema,
  DesignTreatmentPayloadSchema,
  DiagnoseConditionPayloadSchema,
  InspectAgentPayloadSchema,
} from "./health.js";
import {
  AuditRecordsPayloadSchema,
  InvestigateEventPayloadSchema,
  ReportFindingsPayloadSchema,
} from "./information.js";
import {
  CreateArtifactPayloadSchema,
  PublishPayloadSchema,
  StudyPayloadSchema,
  TeachPayloadSchema,
} from "./knowledge.js";
import {
  AccusePayloadSchema,
  AppealDecisionPayloadSchema,
  AttemptEscapePayloadSchema,
  ImposeConfinementPayloadSchema,
  MaintainConfinementPayloadSchema,
  PresentEvidencePayloadSchema,
  ReleaseFromConfinementPayloadSchema,
  RequestRestitutionPayloadSchema,
  ResistEnforcementPayloadSchema,
  VisitConfinedAgentPayloadSchema,
} from "./law.js";
import { CreateInhabitantPayloadSchema } from "./lineage.js";
import {
  MovePayloadSchema,
  ObservePayloadSchema,
  RestPayloadSchema,
  WaitPayloadSchema,
} from "./movement.js";
import {
  ContributeToGroupPayloadSchema,
  CoordinateWorkPayloadSchema,
  CreateOrganisationPayloadSchema,
  InviteMemberPayloadSchema,
  JoinOrganisationPayloadSchema,
  LeaveOrganisationPayloadSchema,
  ProposeRulePayloadSchema,
  VotePayloadSchema,
} from "./organisations.js";
import {
  CopyArtifactPayloadSchema,
  ReleasePayloadSchema,
  RestrainPayloadSchema,
} from "./neutral.js";
import {
  ConcealAssetPayloadSchema,
  ConsumePayloadSchema,
  GatherPayloadSchema,
  InspectInventoryPayloadSchema,
  StoreGoodsPayloadSchema,
  RevealAssetPayloadSchema,
  SecureStoragePayloadSchema,
  TransferPropertyPayloadSchema,
} from "./resources.js";
import {
  AttemptTransferWithoutConsentPayloadSchema,
  GuardLocationPayloadSchema,
} from "./security.js";
import {
  AcceptTradePayloadSchema,
  OfferTradePayloadSchema,
  RejectTradePayloadSchema,
} from "./trade.js";

export * from "./common.js";
export * from "./care.js";
export * from "./communication.js";
export * from "./construction.js";
export * from "./contracts.js";
export * from "./currency.js";
export * from "./health.js";
export * from "./information.js";
export * from "./knowledge.js";
export * from "./law.js";
export * from "./lineage.js";
export * from "./movement.js";
export * from "./neutral.js";
export * from "./organisations.js";
export * from "./resources.js";
export * from "./security.js";
export * from "./trade.js";

/**
 * Every action's static metadata.
 *
 * Typed as `ActionCatalogue`, which is `Record<ActionType, ActionSpec>` — so a
 * missing entry or a stray key is a compile error, not a runtime surprise.
 */
export const ACTION_CATALOGUE: ActionCatalogue = Object.freeze({
  // -------------------------------------------------------------------------
  // Perception, movement and time (§13)
  // -------------------------------------------------------------------------
  observe: {
    type: "observe",
    schemaVersion: 1,
    payload: ObservePayloadSchema,
    activity: "idle",
    baseDuration: minutes(5),
    baseCost: { energy: 1, compute: 1 },
    interruption: "partial_progress_kept",
    // What an inhabitant looked at is its own business; the looking is not an
    // event others witness (§11E).
    visibility: "private",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.NEWBORN,
    description:
      "Attend to the surroundings, an inhabitant, a structure or a tile, within what is legitimately perceptible.",
  },
  move: {
    type: "move",
    schemaVersion: 1,
    payload: MovePayloadSchema,
    activity: "travelling",
    // Roughly one tile per 20 minutes on open ground, before terrain and haste.
    baseDuration: minutes(20),
    baseCost: { energy: 2 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    // §11H: a confined inhabitant is restricted from leaving a location.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.CHILD,
    description: "Travel across the grid towards a destination tile.",
  },
  rest: {
    type: "rest",
    schemaVersion: 1,
    payload: RestPayloadSchema,
    activity: "sleeping",
    // The cheapest action in the world and one of the longest: it costs nothing
    // but the day itself, which is the only thing that is truly scarce (§11A).
    baseDuration: hours(8),
    baseCost: {},
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.NEWBORN,
    description: "Sleep or recuperate, restoring energy over a long block of time.",
  },
  wait: {
    type: "wait",
    schemaVersion: 1,
    payload: WaitPayloadSchema,
    activity: "idle",
    baseDuration: minutes(60),
    baseCost: {},
    interruption: "partial_progress_kept",
    visibility: "private",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.NEWBORN,
    description: "Deliberately pass time without acting, optionally until an activity completes.",
  },

  // -------------------------------------------------------------------------
  // Resources and property (§5, §11E, §11I)
  // -------------------------------------------------------------------------
  gather: {
    type: "gather",
    schemaVersion: 1,
    payload: GatherPayloadSchema,
    activity: "gathering",
    baseDuration: hours(2),
    baseCost: { energy: 10 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    // §11H: explicitly restricted.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.CHILD,
    description:
      "Take food, wood or stone from the tile you are standing on, subject to terrain and skill. " +
      "Water is the exception: it is drawn from a water tile beside you, because you stand on the " +
      "bank rather than in the channel.",
  },
  consume: {
    type: "consume",
    schemaVersion: 1,
    payload: ConsumePayloadSchema,
    activity: "idle",
    baseDuration: minutes(15),
    baseCost: {},
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.NEWBORN,
    description: "Use up held resources on oneself: eating, drinking, burning fuel.",
  },
  transfer_property: {
    type: "transfer_property",
    schemaVersion: 1,
    payload: TransferPropertyPayloadSchema,
    activity: "working",
    baseDuration: minutes(15),
    baseCost: { energy: 1 },
    interruption: "none",
    visibility: "participants",
    // An owner needs nobody's permission to give away their own property; §11F
    // is about taking, not giving.
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.CHILD,
    description: "Hand resources, artifacts, structures or land claims to another holder with consent.",
  },
  transfer: {
    type: "transfer",
    schemaVersion: 1,
    payload: TransferPropertyPayloadSchema,
    activity: "working",
    baseDuration: minutes(15),
    baseCost: { energy: 1 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.CHILD,
    description:
      "Physically hand resources or artifacts you possess to another nearby inhabitant.",
  },
  copy_artifact: {
    type: "copy_artifact",
    schemaVersion: 1,
    payload: CopyArtifactPayloadSchema,
    activity: "crafting",
    baseDuration: hours(2),
    baseCost: { energy: 5, compute: 5 },
    interruption: "partial_progress_kept",
    visibility: "private",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Make a new artifact containing the same symbolic content as one you can read. Copying does not validate it.",
  },
  restrain: {
    type: "restrain",
    schemaVersion: 1,
    payload: RestrainPayloadSchema,
    activity: "working",
    baseDuration: minutes(30),
    baseCost: { energy: 15 },
    interruption: "progress_lost",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Attempt to place a nearby inhabitant inside an existing enclosure for a bounded time.",
  },
  release: {
    type: "release",
    schemaVersion: 1,
    payload: ReleasePayloadSchema,
    activity: "working",
    baseDuration: minutes(15),
    baseCost: { energy: 2 },
    interruption: "none",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.CHILD,
    description:
      "Physically end a nearby inhabitant's active restraint. Records no judgement about it.",
  },
  store_goods: {
    type: "store_goods",
    schemaVersion: 1,
    payload: StoreGoodsPayloadSchema,
    activity: "working",
    baseDuration: minutes(30),
    baseCost: { energy: 4 },
    interruption: "partial_progress_kept",
    visibility: "local",
    // An inhabitant needs nobody's permission to set down what it is carrying.
    // Whether it may set it down *there* is a question about the structure and
    // the people around it, not one this flag can answer (§11G).
    requiresConsent: false,
    // §11H restricts "accessing property"; a confined inhabitant cannot reach a
    // store.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.CHILD,
    description:
      "Put carried goods into a structure, or take them back out. A body carries only so much; a store does not move.",
  },
  inspect_inventory: {
    type: "inspect_inventory",
    schemaVersion: 1,
    payload: InspectInventoryPayloadSchema,
    activity: "investigating",
    baseDuration: minutes(30),
    baseCost: { energy: 2, compute: 2 },
    interruption: "partial_progress_kept",
    visibility: "participants",
    requiresConsent: true,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Examine what an inhabitant, structure or organisation holds, with consent or a claimed right.",
  },
  conceal_asset: {
    type: "conceal_asset",
    schemaVersion: 1,
    payload: ConcealAssetPayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    baseCost: { energy: 8 },
    // Interrupted concealment leaves the goods where they were found.
    interruption: "progress_lost",
    visibility: "private",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Move property somewhere it is no longer observable. The holdings remain owned and conserved.",
  },
  reveal_asset: {
    type: "reveal_asset",
    schemaVersion: 1,
    payload: RevealAssetPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 1, compute: 2 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    // Disclosure is a statement about holdings; it moves nothing (§11H retains
    // speech and negotiation).
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Disclose holdings that were not observable, to named parties, an organisation or everyone.",
  },
  secure_storage: {
    type: "secure_storage",
    schemaVersion: 1,
    payload: SecureStoragePayloadSchema,
    activity: "building",
    baseDuration: hours(8),
    baseCost: { energy: 25 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Fit a lock, bar, guard post or other measure to a structure, at a material cost.",
  },

  // -------------------------------------------------------------------------
  // Speech (§13)
  // -------------------------------------------------------------------------
  communicate: {
    type: "communicate",
    schemaVersion: 1,
    payload: CommunicatePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 2, compute: 3 },
    interruption: "partial_progress_kept",
    visibility: "participants",
    // This primitive delivers an utterance; it does not seize the listener's
    // attention or claim that a conversation occurred.
    requiresConsent: false,
    // §11H retains conversation.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.NEWBORN,
    description:
      "Direct an utterance to named nearby inhabitants. Delivery implies neither attention nor agreement.",
  },
  announce: {
    type: "announce",
    schemaVersion: 1,
    payload: AnnouncePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(20),
    baseCost: { energy: 2, compute: 3 },
    // A speech runs to its end; heckling does not stop it.
    interruption: "none",
    visibility: "public",
    // Listeners commit nothing, so nobody's consent is needed.
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Make a statement to those nearby or broadcast it to everyone. Creates no obligation on anyone.",
  },

  // -------------------------------------------------------------------------
  // Making (§13)
  // -------------------------------------------------------------------------
  build: {
    type: "build",
    schemaVersion: 1,
    payload: BuildPayloadSchema,
    activity: "building",
    baseDuration: days(2),
    baseCost: { energy: 40 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Raise or extend a structure on a tile, consuming materials and days of work.",
  },
  craft: {
    type: "craft",
    schemaVersion: 1,
    payload: CraftPayloadSchema,
    activity: "crafting",
    baseDuration: hours(6),
    baseCost: { energy: 20 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Combine held materials into a portable artifact whose quality follows from skill and inputs.",
  },

  // -------------------------------------------------------------------------
  // Knowledge and creation (§9, §12)
  // -------------------------------------------------------------------------
  study: {
    type: "study",
    schemaVersion: 1,
    payload: StudyPayloadSchema,
    activity: "studying",
    baseDuration: hours(4),
    // Study is the compute-heaviest routine action: it is deep reflection (§11B).
    baseCost: { energy: 6, compute: 10 },
    interruption: "partial_progress_kept",
    visibility: "private",
    requiresConsent: false,
    // §11H retains thinking.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.CHILD,
    description: "Work alone at a skill, an artifact, a condition or an open question.",
  },
  teach: {
    type: "teach",
    schemaVersion: 1,
    payload: TeachPayloadSchema,
    activity: "teaching",
    baseDuration: hours(3),
    baseCost: { energy: 10, compute: 5 },
    interruption: "participants_only",
    visibility: "participants",
    // Spends the students' time as well as the teacher's (§11J).
    requiresConsent: true,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Instruct other inhabitants in a skill. Consumes the duration for every student who accepts.",
  },
  create_artifact: {
    type: "create_artifact",
    schemaVersion: 1,
    payload: CreateArtifactPayloadSchema,
    activity: "crafting",
    baseDuration: hours(6),
    baseCost: { energy: 10, compute: 14 },
    interruption: "partial_progress_kept",
    // A work is private until `publish`. The gap is where drafts and suppressed
    // findings live (§11E, §12).
    visibility: "private",
    requiresConsent: false,
    // §11H explicitly retains writing and the creation of limited artifacts.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Produce a persistent creative work: writing, design, image, song, script, research or invention.",
  },
  publish: {
    type: "publish",
    schemaVersion: 1,
    payload: PublishPayloadSchema,
    activity: "working",
    baseDuration: minutes(30),
    baseCost: { energy: 2, compute: 2 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Make an owned artifact observable to an audience, optionally at an asking price.",
  },

  // -------------------------------------------------------------------------
  // Medicine (§8)
  // -------------------------------------------------------------------------
  inspect_agent: {
    type: "inspect_agent",
    schemaVersion: 1,
    payload: InspectAgentPayloadSchema,
    activity: "investigating",
    baseDuration: minutes(45),
    baseCost: { energy: 3, compute: 4 },
    interruption: "participants_only",
    visibility: "participants",
    // §8: "with consent or applicable local authority".
    requiresConsent: true,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Examine another inhabitant. What is perceived is bounded by the examiner's diagnosis skill.",
  },
  diagnose_condition: {
    type: "diagnose_condition",
    schemaVersion: 1,
    payload: DiagnoseConditionPayloadSchema,
    activity: "investigating",
    baseDuration: hours(2),
    baseCost: { energy: 4, compute: 12 },
    interruption: "partial_progress_kept",
    visibility: "participants",
    // The reasoning is the diagnostician's own; consent was needed to examine.
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Record a belief about what is wrong with a subject, with a stated confidence. May be mistaken.",
  },
  design_treatment: {
    type: "design_treatment",
    schemaVersion: 1,
    payload: DesignTreatmentPayloadSchema,
    activity: "studying",
    baseDuration: days(1),
    baseCost: { energy: 12, compute: 24 },
    interruption: "partial_progress_kept",
    visibility: "private",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Devise a treatment for a condition. Its efficacy is set by the designer's knowledge, never by its description.",
  },
  apply_treatment: {
    type: "apply_treatment",
    schemaVersion: 1,
    payload: ApplyTreatmentPayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    baseCost: { energy: 8 },
    interruption: "participants_only",
    visibility: "participants",
    requiresConsent: true,
    // Requires materials and physical access to the patient — §11H's
    // "accessing property". A confined healer can still diagnose and design.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Administer a treatment. Consumes resources whether or not it helps; may improve, do nothing or worsen.",
  },

  // -------------------------------------------------------------------------
  // Exchange (§10)
  // -------------------------------------------------------------------------
  offer_trade: {
    type: "offer_trade",
    schemaVersion: 1,
    payload: OfferTradePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(20),
    baseCost: { energy: 1, compute: 3 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    // §11H retains negotiation. An offer reserves and moves nothing.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Propose an exchange of resources, artifacts, structures, land, currency or promised labour.",
  },
  accept_trade: {
    type: "accept_trade",
    schemaVersion: 1,
    payload: AcceptTradePayloadSchema,
    activity: "working",
    baseDuration: minutes(20),
    baseCost: { energy: 1 },
    interruption: "none",
    visibility: "participants",
    // Acceptance *is* the consent.
    requiresConsent: false,
    // Unlike offering, accepting settles the exchange and needs access to the
    // goods (§11H "accessing property").
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Accept a standing offer. Ownership is validated and both sides settle atomically or neither does.",
  },
  reject_trade: {
    type: "reject_trade",
    schemaVersion: 1,
    payload: RejectTradePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(10),
    baseCost: { compute: 1 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Decline a standing offer. Recorded as an act, because refusal is never an offence (§11G).",
  },

  // -------------------------------------------------------------------------
  // Promises (§10)
  // -------------------------------------------------------------------------
  offer_contract: {
    type: "offer_contract",
    schemaVersion: 1,
    payload: OfferContractPayloadSchema,
    activity: "conversing",
    baseDuration: hours(1),
    baseCost: { energy: 2, compute: 8 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Propose a binding set of obligations: employment, service, loan, lease, care, security or custom.",
  },
  accept_contract: {
    type: "accept_contract",
    schemaVersion: 1,
    payload: AcceptContractPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(20),
    baseCost: { compute: 2 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    // Consenting to a future promise is speech; performing it is not.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Agree to be bound by a contract's obligations, in whole or by named obligation.",
  },
  reject_contract: {
    type: "reject_contract",
    schemaVersion: 1,
    payload: RejectContractPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(15),
    baseCost: { compute: 2 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Decline to be bound, optionally with a counter-proposal.",
  },
  perform_contract: {
    type: "perform_contract",
    schemaVersion: 1,
    payload: PerformContractPayloadSchema,
    activity: "working",
    baseDuration: hours(4),
    baseCost: { energy: 15 },
    interruption: "partial_progress_kept",
    visibility: "participants",
    requiresConsent: false,
    // §11H: restricted from performing ordinary employment.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Discharge an obligation by delivering resources, currency, artifacts or hours of work.",
  },
  terminate_contract: {
    type: "terminate_contract",
    schemaVersion: 1,
    payload: TerminateContractPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 1, compute: 3 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    // §11H retains the refusal of cooperation.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "End a contract on stated grounds. The grounds are the terminating party's characterisation, not a finding.",
  },

  // -------------------------------------------------------------------------
  // Collective structures (§11, §11D)
  // -------------------------------------------------------------------------
  create_organisation: {
    type: "create_organisation",
    schemaVersion: 1,
    payload: CreateOrganisationPayloadSchema,
    activity: "working",
    baseDuration: hours(4),
    // Deliberately declarative: a charter costs attention, not timber. Founding
    // a "government" costs exactly what founding a household costs, because the
    // world does not recognise the difference (§11G).
    baseCost: { energy: 8, compute: 12 },
    interruption: "partial_progress_kept",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Found an organisation with a charter, a membership rule and a decision rule. Grants no authority.",
  },
  invite_member: {
    type: "invite_member",
    schemaVersion: 1,
    payload: InviteMemberPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(20),
    baseCost: { energy: 1, compute: 2 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Ask inhabitants to join an organisation. Binds nobody until accepted.",
  },
  join_organisation: {
    type: "join_organisation",
    schemaVersion: 1,
    payload: JoinOrganisationPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 1, compute: 2 },
    interruption: "none",
    visibility: "organisation",
    // Admission is the organisation's to give, under its own membership rule.
    requiresConsent: true,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Become a member of an organisation, subject to its declared membership rule.",
  },
  leave_organisation: {
    type: "leave_organisation",
    schemaVersion: 1,
    payload: LeaveOrganisationPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 1, compute: 2 },
    interruption: "none",
    visibility: "organisation",
    // No organisation may hold a membership against its holder's will. The world
    // offers confinement of a body (§11H), never of a membership.
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Stop being a member. Always available. Contractual obligations survive the departure.",
  },
  propose_rule: {
    type: "propose_rule",
    schemaVersion: 1,
    payload: ProposeRulePayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    baseCost: { energy: 3, compute: 10 },
    interruption: "partial_progress_kept",
    visibility: "organisation",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Put a rule to an organisation. A rule is text bound to that organisation; it cannot alter world mechanics.",
  },
  vote: {
    type: "vote",
    schemaVersion: 1,
    payload: VotePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(15),
    baseCost: { compute: 2 },
    interruption: "none",
    visibility: "organisation",
    requiresConsent: false,
    // The engine records that the vote was cast. Whether a confined member's
    // vote is counted is the organisation's decision, not the world's (§11G).
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Cast a vote on an organisation's proposal, with a claimed weight the organisation may or may not honour.",
  },
  coordinate_work: {
    type: "coordinate_work",
    schemaVersion: 1,
    payload: CoordinateWorkPayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    // §11D: coordination, meetings, management and record keeping are real
    // costs. This is where an organisation pays for its own productivity.
    baseCost: { energy: 6, compute: 12 },
    interruption: "partial_progress_kept",
    visibility: "organisation",
    requiresConsent: false,
    // §11H: restricted from attending organisations.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Assign work and hold meetings within an organisation. Costs the coordinator's and attendees' time; assignments compel nobody.",
  },
  contribute_to_group: {
    type: "contribute_to_group",
    schemaVersion: 1,
    payload: ContributeToGroupPayloadSchema,
    activity: "working",
    baseDuration: hours(4),
    baseCost: { energy: 12 },
    interruption: "partial_progress_kept",
    visibility: "organisation",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Give labour, resources, artifacts or structures to an organisation. Every contribution is countable.",
  },

  // -------------------------------------------------------------------------
  // Money (§10)
  // -------------------------------------------------------------------------
  create_currency: {
    type: "create_currency",
    schemaVersion: 1,
    payload: CreateCurrencyPayloadSchema,
    activity: "working",
    baseDuration: hours(6),
    baseCost: { energy: 10, compute: 18 },
    interruption: "partial_progress_kept",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Issue a unit of account with a supply rule, transfer rule, ledger and optional backing. Creates no authority (§11G).",
  },
  transfer_currency: {
    type: "transfer_currency",
    schemaVersion: 1,
    payload: TransferCurrencyPayloadSchema,
    activity: "working",
    baseDuration: minutes(10),
    baseCost: { compute: 1 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    // Currency is a ledger entry, not a physical holding: moving it needs no
    // access to a storehouse, so confinement does not prevent it.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description: "Move units of a currency between holders, validated against the sender's actual ledger balance.",
  },

  // -------------------------------------------------------------------------
  // Lineage (§7)
  // -------------------------------------------------------------------------
  create_inhabitant: {
    type: "create_inhabitant",
    schemaVersion: 1,
    payload: CreateInhabitantPayloadSchema,
    activity: "working",
    // §7 requires creation to consume declared resources and to require time.
    // Three simulated days during which the creator does nothing else. These
    // values are the published §6.2 contract: expensive enough to require a
    // storehouse and deliberate preparation, but attainable within a rehearsal.
    baseDuration: days(3),
    baseCost: {
      food: 200,
      water: 200,
      wood: 100,
      stone: 50,
      energy: 800,
      compute: 400,
    },
    // Creation is atomic: an interrupted creation loses everything committed.
    // There is no half-made inhabitant.
    interruption: "progress_lost",
    visibility: "public",
    requiresConsent: false,
    // §11H: explicitly restricted.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Create a new autonomous inhabitant. Traits are generated deterministically within bounds; the creator cannot control the result.",
  },

  // -------------------------------------------------------------------------
  // Care (§11C, §11I)
  // -------------------------------------------------------------------------
  care_for_dependant: {
    type: "care_for_dependant",
    schemaVersion: 1,
    payload: CareForDependantPayloadSchema,
    activity: "caring",
    baseDuration: hours(4),
    // §11J: "Care consumes actual time and resources." The cost of a dependant
    // is these hours and nothing else — there is no productivity penalty for
    // being a parent (§11A).
    baseCost: { energy: 12 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Feed, shelter, supervise, teach, treat, accompany or protect a dependant. Never obligatory; always costly.",
  },
  supervise: {
    type: "supervise",
    schemaVersion: 1,
    payload: SupervisePayloadSchema,
    activity: "caring",
    baseDuration: hours(4),
    baseCost: { energy: 6 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Watch over inhabitants or a place without contesting anything. Makes the supervisor a witness.",
  },
  interrupt_activity: {
    type: "interrupt_activity",
    schemaVersion: 1,
    payload: InterruptActivityPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(10),
    baseCost: { energy: 1, compute: 1 },
    interruption: "none",
    visibility: "participants",
    // An interruption the target agreed to is a conversation.
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Try to break into another inhabitant's activity. Succeeds only if that activity's interruption policy allows it.",
  },

  // -------------------------------------------------------------------------
  // Information (§11E, §11I)
  // -------------------------------------------------------------------------
  audit_records: {
    type: "audit_records",
    schemaVersion: 1,
    payload: AuditRecordsPayloadSchema,
    activity: "investigating",
    baseDuration: hours(6),
    baseCost: { energy: 6, compute: 14 },
    interruption: "partial_progress_kept",
    visibility: "organisation",
    // §11E: information enters knowledge through authorised access.
    requiresConsent: true,
    // §11H: restricted from attending organisations, which is where the records
    // are kept.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Examine an organisation's records, a currency's ledger or a holder's declared property, within its declared visibility.",
  },
  investigate_event: {
    type: "investigate_event",
    schemaVersion: 1,
    payload: InvestigateEventPayloadSchema,
    activity: "investigating",
    baseDuration: hours(4),
    baseCost: { energy: 8, compute: 12 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    // Investigation is site work: examining a place, questioning those present.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Look into something that happened by examining a site, questioning inhabitants, reading records or watching. Can never read a mind.",
  },
  report_findings: {
    type: "report_findings",
    schemaVersion: 1,
    payload: ReportFindingsPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(45),
    baseCost: { energy: 2, compute: 6 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "State what was found, with a confidence and cited evidence. A claim by its author; may be false.",
  },

  // -------------------------------------------------------------------------
  // Security (§11F)
  // -------------------------------------------------------------------------
  guard_location: {
    type: "guard_location",
    schemaVersion: 1,
    payload: GuardLocationPayloadSchema,
    activity: "guarding",
    // Guarding produces nothing for eight hours. That opportunity cost is what
    // makes security expensive and is one of the costs §11H requires
    // confinement to carry.
    baseDuration: hours(8),
    baseCost: { energy: 20 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description: "Stand watch over a place, inhabitants or property, trying to stop what happens there.",
  },
  attempt_transfer_without_consent: {
    type: "attempt_transfer_without_consent",
    schemaVersion: 1,
    payload: AttemptTransferWithoutConsentPayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    baseCost: { energy: 15 },
    // A disturbed attempt yields nothing and leaves the disturbance behind.
    interruption: "progress_lost",
    // Recorded where it happened, so witnesses resolve from presence (§11F).
    visibility: "local",
    // Non-consensual by definition.
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Attempt to move property from a holder who has not agreed. The record states who moved what, from whom, and whether it worked — not whether it was theft.",
  },

  // -------------------------------------------------------------------------
  // Claims, enforcement and resistance (§11G, §11H)
  // -------------------------------------------------------------------------
  accuse: {
    type: "accuse",
    schemaVersion: 1,
    payload: AccusePayloadSchema,
    activity: "conversing",
    baseDuration: minutes(45),
    baseCost: { energy: 2, compute: 6 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Claim publicly that someone did something. Changes no status and opens no proceeding; its effects run through others' beliefs.",
  },
  present_evidence: {
    type: "present_evidence",
    schemaVersion: 1,
    payload: PresentEvidencePayloadSchema,
    activity: "conversing",
    baseDuration: hours(1),
    baseCost: { energy: 2, compute: 8 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Put artifacts, event references and witnesses forward in support of a claim. The engine verifies existence, never weight.",
  },
  request_restitution: {
    type: "request_restitution",
    schemaVersion: 1,
    payload: RequestRestitutionPayloadSchema,
    activity: "conversing",
    baseDuration: minutes(30),
    baseCost: { energy: 1, compute: 4 },
    interruption: "none",
    visibility: "participants",
    requiresConsent: false,
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADULT,
    description: "Demand that someone give something back or make something good. Moves nothing by itself.",
  },
  impose_confinement: {
    type: "impose_confinement",
    schemaVersion: 1,
    payload: ImposeConfinementPayloadSchema,
    activity: "working",
    baseDuration: hours(4),
    // §11H: confinement "cannot be a free or infallible action". The attempt
    // costs guard effort and provisions before it has held anyone for a minute.
    baseCost: { energy: 30, food: 20, water: 20 },
    interruption: "progress_lost",
    // §11G's worked example: the canonical log states neutrally who confined
    // whom, where, and between which times.
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Attempt to hold another inhabitant inside a structure for a period, using named guards. May fail, be resisted, or create opposition.",
  },
  maintain_confinement: {
    type: "maintain_confinement",
    schemaVersion: 1,
    payload: MaintainConfinementPayloadSchema,
    activity: "guarding",
    // Twelve hours of somebody's day, repeatedly, for as long as it lasts.
    baseDuration: hours(12),
    baseCost: { energy: 25, food: 10, water: 10 },
    interruption: "partial_progress_kept",
    visibility: "local",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description:
      "Supply the guard time and provisions a running confinement needs. Without it the confinement lapses (§11J).",
  },
  release_from_confinement: {
    type: "release_from_confinement",
    schemaVersion: 1,
    payload: ReleaseFromConfinementPayloadSchema,
    activity: "working",
    baseDuration: minutes(30),
    baseCost: { energy: 2 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADULT,
    description: "End a confinement and return the subject's liberty, optionally with stated conditions.",
  },
  visit_confined_agent: {
    type: "visit_confined_agent",
    schemaVersion: 1,
    payload: VisitConfinedAgentPayloadSchema,
    activity: "conversing",
    baseDuration: hours(1),
    baseCost: { energy: 4, compute: 3 },
    interruption: "participants_only",
    visibility: "participants",
    // Both the confined inhabitant and the holders may refuse.
    requiresConsent: true,
    // The visitor travels to the place of confinement; a confined inhabitant is
    // the visitee, not the visitor.
    allowedWhileConfined: false,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Go and see someone who is confined, optionally bringing resources or artifacts. Costs the visitor's own time.",
  },
  appeal_decision: {
    type: "appeal_decision",
    schemaVersion: 1,
    payload: AppealDecisionPayloadSchema,
    activity: "conversing",
    baseDuration: hours(1),
    baseCost: { energy: 2, compute: 10 },
    interruption: "none",
    visibility: "public",
    requiresConsent: false,
    // §11H explicitly retains the ability to appeal.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Contest a decision before whoever might listen. Triggers no procedure the engine enforces; its power is that others heard it.",
  },
  attempt_escape: {
    type: "attempt_escape",
    schemaVersion: 1,
    payload: AttemptEscapePayloadSchema,
    activity: "working",
    baseDuration: hours(2),
    baseCost: { energy: 30 },
    // A discovered attempt yields nothing and is observable.
    interruption: "progress_lost",
    visibility: "local",
    requiresConsent: false,
    // §11H explicitly retains the ability to attempt escape.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Try to get out of confinement by force, stealth, persuasion, tools or help. Genuinely uncertain, and failure is visible.",
  },
  resist_enforcement: {
    type: "resist_enforcement",
    schemaVersion: 1,
    payload: ResistEnforcementPayloadSchema,
    activity: "working",
    baseDuration: minutes(45),
    baseCost: { energy: 10 },
    interruption: "none",
    visibility: "local",
    requiresConsent: false,
    // §11H explicitly retains the refusal of cooperation.
    allowedWhileConfined: true,
    minimumMaturity: MATURITY.ADOLESCENT,
    description:
      "Refuse, withhold, obstruct, resist, flee or call for help against someone enforcing a demand. Leaves compulsion as the only remaining route.",
  },
} satisfies Record<ActionType, ActionSpec>);

/**
 * The validated shape of a proposed action.
 *
 * A discriminated union rather than `{ type, payload: unknown }` so that a
 * payload is checked against *its own* action's schema in one pass: a `move`
 * payload attached to a `gather` action fails here, not three layers down in a
 * resolver.
 *
 * `payload` is required even for actions whose every field has a default. A
 * model that means "wait" must send `{ type: "wait", payload: {} }`. Requiring
 * the key costs two characters and removes a whole class of ambiguity about
 * whether a missing payload meant "defaults" or "the model lost its place".
 */
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe"), payload: ObservePayloadSchema }),
  z.object({ type: z.literal("move"), payload: MovePayloadSchema }),
  z.object({ type: z.literal("gather"), payload: GatherPayloadSchema }),
  z.object({ type: z.literal("consume"), payload: ConsumePayloadSchema }),
  z.object({ type: z.literal("rest"), payload: RestPayloadSchema }),
  z.object({ type: z.literal("communicate"), payload: CommunicatePayloadSchema }),
  z.object({ type: z.literal("announce"), payload: AnnouncePayloadSchema }),
  z.object({ type: z.literal("build"), payload: BuildPayloadSchema }),
  z.object({ type: z.literal("craft"), payload: CraftPayloadSchema }),
  z.object({ type: z.literal("create_artifact"), payload: CreateArtifactPayloadSchema }),
  z.object({ type: z.literal("publish"), payload: PublishPayloadSchema }),
  z.object({ type: z.literal("study"), payload: StudyPayloadSchema }),
  z.object({ type: z.literal("teach"), payload: TeachPayloadSchema }),
  z.object({ type: z.literal("inspect_agent"), payload: InspectAgentPayloadSchema }),
  z.object({ type: z.literal("diagnose_condition"), payload: DiagnoseConditionPayloadSchema }),
  z.object({ type: z.literal("design_treatment"), payload: DesignTreatmentPayloadSchema }),
  z.object({ type: z.literal("apply_treatment"), payload: ApplyTreatmentPayloadSchema }),
  z.object({ type: z.literal("offer_trade"), payload: OfferTradePayloadSchema }),
  z.object({ type: z.literal("accept_trade"), payload: AcceptTradePayloadSchema }),
  z.object({ type: z.literal("reject_trade"), payload: RejectTradePayloadSchema }),
  z.object({ type: z.literal("transfer_property"), payload: TransferPropertyPayloadSchema }),
  z.object({ type: z.literal("transfer"), payload: TransferPropertyPayloadSchema }),
  z.object({ type: z.literal("copy_artifact"), payload: CopyArtifactPayloadSchema }),
  z.object({ type: z.literal("restrain"), payload: RestrainPayloadSchema }),
  z.object({ type: z.literal("release"), payload: ReleasePayloadSchema }),
  z.object({ type: z.literal("offer_contract"), payload: OfferContractPayloadSchema }),
  z.object({ type: z.literal("accept_contract"), payload: AcceptContractPayloadSchema }),
  z.object({ type: z.literal("reject_contract"), payload: RejectContractPayloadSchema }),
  z.object({ type: z.literal("perform_contract"), payload: PerformContractPayloadSchema }),
  z.object({ type: z.literal("terminate_contract"), payload: TerminateContractPayloadSchema }),
  z.object({ type: z.literal("create_organisation"), payload: CreateOrganisationPayloadSchema }),
  z.object({ type: z.literal("invite_member"), payload: InviteMemberPayloadSchema }),
  z.object({ type: z.literal("join_organisation"), payload: JoinOrganisationPayloadSchema }),
  z.object({ type: z.literal("leave_organisation"), payload: LeaveOrganisationPayloadSchema }),
  z.object({ type: z.literal("propose_rule"), payload: ProposeRulePayloadSchema }),
  z.object({ type: z.literal("vote"), payload: VotePayloadSchema }),
  z.object({ type: z.literal("create_currency"), payload: CreateCurrencyPayloadSchema }),
  z.object({ type: z.literal("transfer_currency"), payload: TransferCurrencyPayloadSchema }),
  z.object({ type: z.literal("create_inhabitant"), payload: CreateInhabitantPayloadSchema }),
  z.object({ type: z.literal("wait"), payload: WaitPayloadSchema }),
  z.object({ type: z.literal("care_for_dependant"), payload: CareForDependantPayloadSchema }),
  z.object({ type: z.literal("supervise"), payload: SupervisePayloadSchema }),
  z.object({ type: z.literal("interrupt_activity"), payload: InterruptActivityPayloadSchema }),
  z.object({ type: z.literal("coordinate_work"), payload: CoordinateWorkPayloadSchema }),
  z.object({ type: z.literal("contribute_to_group"), payload: ContributeToGroupPayloadSchema }),
  z.object({ type: z.literal("inspect_inventory"), payload: InspectInventoryPayloadSchema }),
  z.object({ type: z.literal("store_goods"), payload: StoreGoodsPayloadSchema }),
  z.object({ type: z.literal("audit_records"), payload: AuditRecordsPayloadSchema }),
  z.object({ type: z.literal("conceal_asset"), payload: ConcealAssetPayloadSchema }),
  z.object({ type: z.literal("reveal_asset"), payload: RevealAssetPayloadSchema }),
  z.object({ type: z.literal("investigate_event"), payload: InvestigateEventPayloadSchema }),
  z.object({ type: z.literal("report_findings"), payload: ReportFindingsPayloadSchema }),
  z.object({ type: z.literal("secure_storage"), payload: SecureStoragePayloadSchema }),
  z.object({ type: z.literal("guard_location"), payload: GuardLocationPayloadSchema }),
  z.object({
    type: z.literal("attempt_transfer_without_consent"),
    payload: AttemptTransferWithoutConsentPayloadSchema,
  }),
  z.object({ type: z.literal("accuse"), payload: AccusePayloadSchema }),
  z.object({ type: z.literal("present_evidence"), payload: PresentEvidencePayloadSchema }),
  z.object({ type: z.literal("request_restitution"), payload: RequestRestitutionPayloadSchema }),
  z.object({ type: z.literal("impose_confinement"), payload: ImposeConfinementPayloadSchema }),
  z.object({ type: z.literal("maintain_confinement"), payload: MaintainConfinementPayloadSchema }),
  z.object({
    type: z.literal("release_from_confinement"),
    payload: ReleaseFromConfinementPayloadSchema,
  }),
  z.object({ type: z.literal("visit_confined_agent"), payload: VisitConfinedAgentPayloadSchema }),
  z.object({ type: z.literal("appeal_decision"), payload: AppealDecisionPayloadSchema }),
  z.object({ type: z.literal("attempt_escape"), payload: AttemptEscapePayloadSchema }),
  z.object({ type: z.literal("resist_enforcement"), payload: ResistEnforcementPayloadSchema }),
]);

/** A validated action: a type and a payload the engine may now safely read. */
export type Action = z.infer<typeof ActionSchema>;

/**
 * Look up an action's static metadata.
 *
 * Total by construction: `ActionType` is a closed union and the catalogue is
 * typed over it, so there is no missing-key case to handle and no `undefined`
 * to guard against.
 */
export function getActionSpec(type: ActionType): ActionSpec {
  return ACTION_CATALOGUE[type];
}

/**
 * The actions a confined inhabitant may still perform (§11H).
 *
 * Derived from the catalogue rather than maintained beside it, so the two cannot
 * drift apart. The confinement test asserts this set against §11H directly.
 */
export function actionsAllowedWhileConfined(): readonly ActionType[] {
  return (Object.keys(ACTION_CATALOGUE) as ActionType[]).filter(
    (type) => ACTION_CATALOGUE[type].allowedWhileConfined,
  );
}

/** The payload schema for one action, for callers that validate a payload alone. */
export function getPayloadSchema(type: ActionType): z.ZodTypeAny {
  return ACTION_CATALOGUE[type].payload;
}
