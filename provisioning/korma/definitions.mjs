/**
 * KORMA-USA HubSpot data model — single source of truth.
 *
 * Mirrors the design doc "KORMA-USA HubSpot Design — CRM + Belt Rank Management"
 * (§3 data model, §4 pipelines). provision.mjs creates what is missing;
 * export.mjs writes the review spreadsheet (CSV) and a JSON snapshot.
 *
 * Rank ladders are a DRAFT pending Frank's confirmation (rank names, belt
 * colors, Poom ranks, stripes). Option `value`s are stable codes so labels can
 * be renamed later without breaking filters or code.
 */

// ─── option helpers ─────────────────────────────────────────────────────────

const opts = (...labels) =>
  labels.map((label, i) => ({
    label,
    value: label
      .toLowerCase()
      .replace(/\+/g, "plus")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
    displayOrder: i,
  }));

/** Options with explicit [value, label] pairs (keeps existing codes stable). */
const coded = (...pairs) => pairs.map(([value, label], i) => ({ label, value, displayOrder: i }));

const ord = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

/** Gup (colored belt) ranks from `from` down to 1, then optional Poom, then Dan. */
function ladder({ gup = 10, poom = 0, dan = 9 }) {
  const out = [];
  for (let g = gup; g >= 1; g--) out.push([`g${g}`, `${ord(g)} Gup`]);
  for (let p = 1; p <= poom; p++) out.push([`p${p}`, `${ord(p)} Poom`]);
  for (let d = 1; d <= dan; d++) out.push([`d${d}`, `${ord(d)} Dan`]);
  return coded(...out);
}

export const LADDERS = {
  tkd: ladder({ gup: 10, poom: 4, dan: 9 }), // Taekwondo Changmookwan (Kukkiwon-style, draft)
  hkd: ladder({ gup: 10, poom: 0, dan: 9 }), // Hapkido Migukyongkwan (draft)
  kumdo: ladder({ gup: 9, poom: 0, dan: 8 }), // Kumdo (draft)
};
/** Union ladder for deal-level Rank From / Rank To. */
export const ALL_RANKS = ladder({ gup: 10, poom: 4, dan: 9 });

const PROGRAMS = opts("Taekwondo", "Hapkido", "Kumdo", "Homeschool PE", "Seminar");
const FEDERATIONS = opts("WT Changmookwan", "WKMAF", "WHMAF", "Kukkiwon");
const PLANS = opts("Monthly", "6-Month", "Annual", "Family", "Homeschool Term", "Drop-in", "Comp");

// ─── property builders ──────────────────────────────────────────────────────

const text = (name, label, description = "") => ({ name, label, type: "string", fieldType: "text", description });
const phone = (name, label, description = "") => ({ name, label, type: "string", fieldType: "phonenumber", description });
const num = (name, label, description = "") => ({ name, label, type: "number", fieldType: "number", description });
const date = (name, label, description = "") => ({ name, label, type: "date", fieldType: "date", description });
const bool = (name, label, description = "") => ({
  name,
  label,
  type: "bool",
  fieldType: "booleancheckbox",
  options: coded(["true", "Yes"], ["false", "No"]),
  description,
});
const select = (name, label, options, description = "") => ({ name, label, type: "enumeration", fieldType: "select", options, description });
const multi = (name, label, options, description = "") => ({ name, label, type: "enumeration", fieldType: "checkbox", options, description });

function rankGroup(prefix, disc, discLabel) {
  const L = LADDERS[disc];
  const p = `korma_${prefix}_`;
  return [
    select(`${p}rank`, `${discLabel} Current Rank`, L),
    num(`${p}rank_order`, `${discLabel} Rank Order`, "1 = lowest Gup; increases with rank. Set with the rank (app)."),
    date(`${p}rank_date`, `${discLabel} Rank Date`, "Date of last promotion."),
    num(`${p}stripes`, `${discLabel} Stripes`, "0–4 skill stripes at current rank."),
    select(`${p}next_rank`, `${discLabel} Next Rank`, L),
    num(`${p}classes_at_rank`, `${discLabel} Classes at Rank`, "Synced nightly from app attendance."),
    date(`${p}eligible_date`, `${discLabel} Eligible Date`, "App: rank date + minimum days at rank."),
    bool(`${p}test_eligible`, `${discLabel} Eligible to Test`, "App: days, classes and skills requirements met."),
    text(`${p}cert_number`, `${discLabel} Certificate No.`, "Federation certificate for current Dan/Poom."),
    select(`${p}instructor_level`, `${discLabel} Instructor Level`, opts("None", "Assistant", "Instructor", "Master Instructor")),
  ];
}

// ─── groups and properties ──────────────────────────────────────────────────

export const GROUPS = {
  contacts: [
    { name: "korma_member_profile", label: "KORMA · Member Profile", displayOrder: 1 },
    { name: "korma_family", label: "KORMA · Family & Emergency", displayOrder: 2 },
    { name: "korma_rank_summary", label: "KORMA · Rank Summary", displayOrder: 3 },
    { name: "korma_rank_tkd", label: "KORMA · Rank — Taekwondo", displayOrder: 4 },
    { name: "korma_rank_hkd", label: "KORMA · Rank — Hapkido", displayOrder: 5 },
    { name: "korma_rank_kumdo", label: "KORMA · Rank — Kumdo", displayOrder: 6 },
    { name: "korma_attendance", label: "KORMA · Attendance", displayOrder: 7 },
    { name: "korma_billing", label: "KORMA · Membership & Billing", displayOrder: 8 },
    { name: "korma_waivers", label: "KORMA · Waivers & Agreements", displayOrder: 9 },
    { name: "korma_lead", label: "KORMA · Lead & Marketing", displayOrder: 10 },
    { name: "korma_federation", label: "KORMA · Federation", displayOrder: 11 },
  ],
  companies: [{ name: "korma_school", label: "KORMA · School / Dojang", displayOrder: 1 }],
  deals: [{ name: "korma_deal", label: "KORMA · Deal Details", displayOrder: 1 }],
};

const inGroup = (groupName, props) => props.map((p) => ({ ...p, groupName }));

export const PROPERTIES = {
  contacts: [
    ...inGroup("korma_member_profile", [
      text("korma_member_id", "Member ID", "Assigned by the app; printed on cards and certificates."),
      multi("korma_member_type", "Member Type", opts("Student", "Parent/Guardian", "Instructor", "Master", "School Owner", "Federation Applicant", "Seminar Client")),
      select("korma_member_status", "Member Status", opts("Prospect", "Trial", "Active", "Frozen", "Inactive", "Alumni")),
      select("korma_status_reason", "Status Reason", opts("Schedule", "Cost", "Moved", "Lost interest", "Graduated", "Other"), "No medical reasons in CRM."),
      date("korma_join_date", "Join Date", "First paid enrollment."),
      date("korma_freeze_until", "Frozen Until"),
      date("korma_cancel_date", "Cancel Date"),
      multi("korma_programs", "Programs", PROGRAMS),
      select("korma_age_group", "Age Group", opts("Little Dragons (4-6)", "Youth (7-12)", "Teen (13-17)", "Adult (18+)"), "Set by app from date of birth."),
      date("date_of_birth", "Date of Birth", "The only DOB field (replaces korma_date_of_birth). May already exist in the portal."),
      select("korma_sex", "Sex", coded(["M", "M"], ["F", "F"]), "Required by federation forms; replaces changmookwan_/wkmaf_/whmaf_sex."),
      select("korma_preferred_language", "Preferred Language", opts("English", "Korean")),
      multi("korma_groups", "Groups", opts("Demo Team", "Competition Team", "Leadership", "Assistant Instructor")),
      text("korma_home_school_name", "Home School (text)", "Fallback only when the school is not a Company yet."),
    ]),
    ...inGroup("korma_family", [
      bool("korma_is_minor", "Minor", "Set by app from date of birth."),
      text("korma_household_id", "Household ID", "Same value on every family member."),
      text("korma_guardian_name", "Guardian Name"),
      text("korma_guardian_email", "Guardian Email", "Emails for minors go here."),
      phone("korma_guardian_phone", "Guardian Phone"),
      select("korma_guardian_relationship", "Guardian Relationship", opts("Parent", "Legal guardian", "Grandparent", "Other")),
      text("korma_emergency_name", "Emergency Contact"),
      phone("korma_emergency_phone", "Emergency Phone"),
    ]),
    ...inGroup("korma_rank_summary", [
      num("korma_highest_dan", "Highest Dan (any discipline)"),
      text("korma_instructor_of_record", "Instructor of Record", "Lineage: instructor who promoted them."),
    ]),
    ...inGroup("korma_rank_tkd", rankGroup("tkd", "tkd", "TKD")),
    ...inGroup("korma_rank_hkd", rankGroup("hkd", "hkd", "HKD")),
    ...inGroup("korma_rank_kumdo", rankGroup("kumdo", "kumdo", "Kumdo")),
    ...inGroup("korma_attendance", [
      date("korma_last_attended", "Last Attended"),
      num("korma_total_classes", "Total Classes"),
      num("korma_classes_30d", "Classes (30 days)"),
      num("korma_classes_90d", "Classes (90 days)"),
      bool("korma_at_risk", "At Risk", "Active with no check-in for the app's threshold (default 14 days)."),
      select("korma_attendance_milestone", "Attendance Milestone", coded(["25", "25 classes"], ["50", "50 classes"], ["100", "100 classes"], ["250", "250 classes"], ["500", "500 classes"], ["1000", "1000 classes"])),
    ]),
    ...inGroup("korma_billing", [
      select("korma_membership_plan", "Membership Plan", PLANS),
      date("korma_membership_start", "Membership Start"),
      date("korma_membership_end", "Membership End / Renewal"),
      num("korma_tuition_monthly", "Monthly Tuition (USD)"),
      select("korma_billing_status", "Billing Status", opts("Current", "Past Due", "Paused", "Cancelled", "Comp"), "Set by Stripe webhook."),
      date("korma_next_bill_date", "Next Bill Date"),
      text("korma_stripe_customer_id", "Stripe Customer ID", "Link-out only; no card data in HubSpot."),
    ]),
    ...inGroup("korma_waivers", [
      date("korma_waiver_signed_date", "Waiver Signed"),
      text("korma_waiver_version", "Waiver Version"),
      text("korma_waiver_signed_by", "Waiver Signed By", "Guardian name for minors."),
      date("korma_agreement_signed_date", "Membership Agreement Signed"),
      text("korma_agreement_version", "Agreement Version"),
      bool("korma_photo_release", "Photo/Media Release"),
    ]),
    ...inGroup("korma_lead", [
      // Existing property: keep current codes (regular_class, seminar, certification) and add new ones.
      select(
        "korma_inquiry_type",
        "Inquiry Type",
        coded(["regular_class", "Regular class"], ["seminar", "Seminar"], ["certification", "Certification"], ["enrollment", "Enrollment"], ["homeschool", "Homeschool"], ["general", "General"]),
      ),
      select("korma_interest_program", "Program of Interest", PROGRAMS),
      select("korma_lead_source", "Lead Source", opts("Website", "Walk-in", "Referral", "Event/Demo", "Social", "Google", "QR Code", "Federation")),
      text("korma_referred_by", "Referred By"),
      date("korma_trial_date", "Trial Class Date"),
      bool("korma_trial_attended", "Trial Attended"),
    ]),
    ...inGroup("korma_federation", [
      multi("korma_federations", "Federations", FEDERATIONS),
      multi("korma_disciplines", "Disciplines Practiced", opts("Taekwondo", "Hapkido", "Kumdo", "Other")),
      text("korma_last_application_ref", "Last Application Ref", "Latest only; every application is also a Certifications deal."),
    ]),
  ],

  companies: inGroup("korma_school", [
    select("korma_school_type", "School Type", opts("KORMA HQ", "Member School", "Affiliate", "Corporate Seminar Client")),
    select("korma_charter_status", "Charter Status", opts("Applicant", "Active", "Lapsed", "Revoked")),
    text("korma_charter_number", "Charter Number"),
    date("korma_charter_start", "Charter Start"),
    date("korma_charter_expires", "Charter Expires"),
    multi("korma_federations", "Federations", FEDERATIONS),
    multi("korma_programs_offered", "Programs Offered", PROGRAMS),
    text("korma_head_instructor", "Head Instructor"),
    num("korma_active_students", "Active Students", "Synced from app."),
  ]),

  deals: inGroup("korma_deal", [
    select("korma_discipline", "Discipline", opts("Taekwondo", "Hapkido", "Kumdo", "Homeschool PE")),
    select("korma_federation", "Federation", opts("WT Changmookwan", "WKMAF", "WHMAF", "Kukkiwon", "KORMA-USA")),
    select("korma_rank_from", "Rank From", ALL_RANKS),
    select("korma_rank_to", "Rank To", ALL_RANKS),
    date("korma_test_date", "Test Date"),
    text("korma_examiner", "Examiner / Board"),
    select("korma_test_result", "Test Result", opts("Pass", "Pass with Conditions", "Retest")),
    num("korma_test_score", "Test Score"),
    multi("korma_cert_types", "Certificates Requested", opts("Dan", "Instructor", "School Charter")),
    num("korma_applied_dan_rank", "Applied Dan Rank"),
    num("korma_instructor_level", "Instructor Level"),
    text("korma_application_ref", "Application Ref"),
    select("korma_evidence_status", "Evidence Status", opts("Missing", "Received", "Verified", "Rejected")),
    select("korma_review_decision", "Review Decision", opts("Approved", "Approved with Override", "Needs Amendment", "Denied")),
    text("korma_certificate_number", "Certificate Number"),
    date("korma_certificate_issued", "Certificate Issued"),
    select("korma_payment_status", "Payment Status", opts("Unpaid", "Paid", "Refunded", "Waived")),
    text("korma_stripe_session_id", "Stripe Session ID"),
    text("korma_discount_code", "Discount Code"),
    select("korma_membership_plan", "Membership Plan", PLANS),
    select("korma_lost_reason", "Lost Reason", opts("No-show", "Price", "Schedule", "Chose another school", "Not ready")),
    select("korma_event_type", "Event Type", opts("Corporate Seminar", "Individual Seminar", "Camp", "Tournament", "Demo")),
    date("korma_event_date", "Event Date"),
  ]),
};

// ─── deal pipelines ─────────────────────────────────────────────────────────
// probability: 0–1. Won stages = 1.0 (closed won), lost stages = 0.0 (closed lost).

const stages = (...list) =>
  list.map(([label, probability], i) => ({ label, displayOrder: i, metadata: { probability: String(probability) } }));

export const PIPELINES = [
  {
    label: "KORMA · Enrollment",
    displayOrder: 1,
    stages: stages(["New Inquiry", 0.1], ["Contacted", 0.2], ["Trial Booked", 0.4], ["Trial Attended", 0.6], ["Offer Sent", 0.8], ["Enrolled", 1.0], ["Lost", 0.0]),
  },
  {
    label: "KORMA · Belt Testing & Promotions",
    displayOrder: 2,
    stages: stages(["Eligible", 0.2], ["Invited", 0.4], ["Registered & Paid", 0.6], ["Tested", 0.8], ["Promoted", 1.0], ["Retest", 0.0]),
  },
  {
    label: "KORMA · Certifications",
    displayOrder: 3,
    stages: stages(
      ["Application Started", 0.1],
      ["Submitted", 0.2],
      ["Evidence Review", 0.4],
      ["Payment Pending", 0.6],
      ["Approved", 0.8],
      ["Sent to Federation", 0.9],
      ["Certificate Issued", 1.0],
      ["Needs Amendment", 0.0],
      ["Denied", 0.0],
    ),
  },
  {
    label: "KORMA · School Charters",
    displayOrder: 4,
    stages: stages(["Inquiry", 0.1], ["Application", 0.3], ["Review", 0.6], ["Fee Paid", 0.9], ["Active", 1.0], ["Declined", 0.0]),
  },
  {
    label: "KORMA · Events & Seminars",
    displayOrder: 5,
    stages: stages(["Inquiry", 0.1], ["Proposal", 0.4], ["Booked", 0.8], ["Delivered", 1.0], ["Lost", 0.0]),
  },
];

/** Legacy properties the site writes today; archived only after migration (not by provision.mjs). */
export const LEGACY = [
  "korma_date_of_birth",
  ...["changmookwan", "wkmaf", "whmaf"].flatMap((f) =>
    ["sex", "disciplines", "application_ref", "applied_certs", "applied_dan_rank", "instructor_level", "gym_name"].map((s) => `${f}_${s}`),
  ),
];
