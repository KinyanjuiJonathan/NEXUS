import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { parseScheduleRequest } from "./parse";
import { baseVerb, generateTitle } from "./title";

const NBO = "Africa/Nairobi";
const now = DateTime.fromISO("2026-11-18T10:00", { zone: NBO }).toMillis(); // a Wednesday
const title = (text: string) => parseScheduleRequest(text, { now, defaultZone: NBO, texasZone: "America/Chicago" }).title;

describe("task titles from plain-language requests", () => {
  it("produces the expected titles", () => {
    expect(title("Repairing Mineh's phone today, for around 3 hours, preferably in the evening Kenya time.")).toBe("Repair Mineh's Phone");
    expect(title("I need to finish my financial report tomorrow morning.")).toBe("Complete Financial Report");
    expect(title("Schedule a Zoom interview with James on Friday at 4 PM.")).toBe("Zoom Interview with James");
    expect(title("Remind me to update my CV this evening.")).toBe("Update My CV");
    expect(title("I want to work on the NEXUS dashboard for two hours tonight.")).toBe("Improve NEXUS Dashboard");
    expect(title("Call the client tomorrow at 10 AM Texas time.")).toBe("Call Client");
  });

  it("keeps the scheduling details out of the title and in the request", () => {
    const r = parseScheduleRequest("Repairing Mineh's phone today, for around 3 hours, preferably in the evening Kenya time.", { now, defaultZone: NBO, texasZone: "America/Chicago" });
    expect(r).toMatchObject({ title: "Repair Mineh's Phone", durationMin: 180, period: "evening", zone: NBO, window: { label: "today" } });
    expect(r.text).toBe("Repairing Mineh's phone today, for around 3 hours, preferably in the evening Kenya time."); // the original is kept
    for (const t of [r.title, title("Write the summary by Friday 5pm, takes 90 minutes, urgent"), title("Gym next Monday at 6pm for an hour")]) {
      expect(t).not.toMatch(/today|tomorrow|friday|monday|hour|minute|evening|kenya|pm\b|urgent/i);
    }
  });

  it("turns the activity into an action", () => {
    expect(title("Writing the quarterly report tomorrow")).toBe("Write Quarterly Report");
    expect(title("Rooting Mineh's phone today, around three hours")).toBe("Root Mineh's Phone");
    expect(title("Cleaning the garage this weekend")).toBe("Clean Garage");
    expect(title("Preparing slides before my next meeting, 45 minutes")).toBe("Prepare Slides");
    expect(title("Studying Swahili tomorrow evening for an hour")).toBe("Study Swahili");
    expect(title("Planning the product launch on Monday")).toBe("Plan Product Launch");
    expect(title("I have to submit the tax form in two hours")).toBe("Submit Tax Form");
    expect(title("Let's review the contract tomorrow afternoon")).toBe("Review Contract");
    expect(title("don't forget to pay rent by tomorrow")).toBe("Pay Rent");
    expect(["repairing", "running", "making", "planning", "calling", "fixing", "studying", "updating", "shipping", "reviewing"].map(baseVerb)).toEqual(["repair", "run", "make", "plan", "call", "fix", "study", "update", "ship", "review"]);
  });

  it("keeps names, acronyms and context, and leaves things that are not actions alone", () => {
    expect(title("Lunch with Amina at noon tomorrow")).toBe("Lunch with Amina");
    expect(title("Meeting with the KRA officer on Friday at 10am")).toBe("Meeting with the KRA Officer");
    expect(title("Training session tomorrow at 2pm for 2 hours")).toBe("Training Session");
    expect(title("Update iPhone and MacBook tonight")).toBe("Update iPhone and MacBook");
    expect(title("Call my mother tomorrow evening")).toBe("Call My Mother");
    expect(title("Work on taxes this weekend, 2 hours")).toBe("Work on Taxes");
    expect(title("Read pages 3 to 4 of the manual tomorrow")).toBe("Read Pages 3 to 4 of the Manual");
    expect(title("Doctor appointment tomorrow at 9am")).toBe("Doctor Appointment");
  });

  it("stays short and tidy", () => {
    const long = title("I need to write the detailed onboarding documentation for the new support team because the old one is out of date, tomorrow morning for 2 hours");
    expect(long.split(" ").length).toBeLessThanOrEqual(9);
    expect(long).toBe("Write Detailed Onboarding Documentation for the New Support Team");
    expect(generateTitle("  the report,  ")).toBe("Report");
    expect(generateTitle("")).toBe("");
    expect(title("tomorrow at 5pm")).toBe("");
  });
});
