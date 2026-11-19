import { describe, expect, it } from "vitest";
import {
	getPeerPath,
	summarizeVoicePeers,
	voiceDroppedByReconnect,
	type VoicePeerState,
} from "@/util/voice";

function makeStats(reports: Array<Record<string, unknown>>): RTCStatsReport {
	const map = new Map<string, unknown>();
	for (const report of reports) {
		map.set(String(report.id), report);
	}
	return map as unknown as RTCStatsReport;
}

describe("voice peer path", () => {
	it("classifies a server-reflexive pair as a direct path", () => {
		const stats = makeStats([
			{ id: "transport", type: "transport", selectedCandidatePairId: "pair" },
			{
				id: "pair",
				type: "candidate-pair",
				localCandidateId: "local",
				remoteCandidateId: "remote",
			},
			{ id: "local", type: "local-candidate", candidateType: "srflx" },
			{ id: "remote", type: "remote-candidate", candidateType: "host" },
		]);
		expect(getPeerPath(stats)).toBe("direct");
	});

	it("classifies a pair with a TURN candidate as relayed", () => {
		const stats = makeStats([
			{ id: "transport", type: "transport", selectedCandidatePairId: "pair" },
			{
				id: "pair",
				type: "candidate-pair",
				localCandidateId: "local",
				remoteCandidateId: "remote",
			},
			{ id: "local", type: "local-candidate", candidateType: "host" },
			{ id: "remote", type: "remote-candidate", candidateType: "relay" },
		]);
		expect(getPeerPath(stats)).toBe("relay");
	});

	it("accepts the legacy selected flag when no transport report is present", () => {
		const stats = makeStats([
			{
				id: "pair",
				type: "candidate-pair",
				selected: true,
				localCandidateId: "local",
				remoteCandidateId: "remote",
			},
			{ id: "local", type: "local-candidate", candidateType: "prflx" },
			{ id: "remote", type: "remote-candidate", candidateType: "prflx" },
		]);
		expect(getPeerPath(stats)).toBe("direct");
	});

	it("stays unknown until a candidate pair is selected", () => {
		const stats = makeStats([
			{ id: "transport", type: "transport" },
			{
				id: "pair",
				type: "candidate-pair",
				localCandidateId: "local",
				remoteCandidateId: "remote",
			},
		]);
		expect(getPeerPath(stats)).toBeNull();
	});

	it("stays unknown when the selected candidates are missing", () => {
		const stats = makeStats([
			{
				id: "pair",
				type: "candidate-pair",
				selected: true,
				localCandidateId: "local",
				remoteCandidateId: "remote",
			},
		]);
		expect(getPeerPath(stats)).toBeNull();
	});
});

describe("voice peer summary", () => {
	it("counts every connection state", () => {
		const states: Record<string, VoicePeerState> = {
			a: "direct",
			b: "direct",
			c: "relay",
			d: "connected",
			e: "connecting",
			f: "failed",
		};
		expect(summarizeVoicePeers(states)).toEqual({
			total: 6,
			direct: 2,
			relay: 1,
			connected: 1,
			connecting: 1,
			failed: 1,
		});
	});

	it("returns zeroed counters without peers", () => {
		expect(summarizeVoicePeers({})).toEqual({
			total: 0,
			direct: 0,
			relay: 0,
			connected: 0,
			connecting: 0,
			failed: 0,
		});
	});
});

/**
 * A reconnect mints a new server-side client id, so the participant list no longer contains
 * the id the voice session joined under. Treating that as a refusal tore the session down
 * silently on every reconnect; it must rejoin instead.
 */
describe("voice reconnect detection", () => {
	it("rejoins when our id changed and we are absent", () => {
		expect(voiceDroppedByReconnect("old-id", "new-id", false, false)).toBe(true);
	});

	it("stays put while we are still listed", () => {
		expect(voiceDroppedByReconnect("id", "id", false, true)).toBe(false);
	});

	it("treats a server refusal as final, not as a reconnect", () => {
		expect(voiceDroppedByReconnect("old-id", "new-id", true, false)).toBe(false);
	});

	it("does not rejoin when there was no session to begin with", () => {
		expect(voiceDroppedByReconnect(null, "new-id", false, false)).toBe(false);
	});

	it("does not rejoin when the id is unchanged", () => {
		expect(voiceDroppedByReconnect("same-id", "same-id", false, false)).toBe(false);
	});
});
