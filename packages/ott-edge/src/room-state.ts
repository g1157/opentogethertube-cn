import { Grants } from "ott-common/permissions.js";
import {
	BehaviorOption,
	PlayerStatus,
	QueueMode,
	Role,
	Visibility,
	type RoomUserInfo,
} from "ott-common/models/types.js";
import {
	RoomRequestType as R,
	type PlaybackPrepared,
	type ServerMessage,
	type ServerMessageSync,
} from "ott-common/models/messages.js";
import type { QueueItem, VideoId } from "ott-common/models/video.js";
import { ApiError, type GuestSession } from "./types";
import { commandPermissions, type Command } from "./commands";

export interface Member {
	id: string;
	session: GuestSession;
	status: PlayerStatus;
}
export interface Snapshot {
	version: 1;
	name: string;
	title: string;
	description: string;
	isTemporary: boolean;
	visibility: Visibility;
	queueMode: QueueMode;
	ownerId: string;
	roles: Record<string, Role>;
	grants: [Role, number][];
	currentSource: QueueItem | null;
	queue: QueueItem[];
	isPlaying: boolean;
	position: number;
	anchorAt: number;
	playbackSpeed: number;
	resumeOnNextJoin: boolean;
	emptySince: number | null;
	preparation: {
		id: string;
		clientId: string;
		video: VideoId;
		position: number;
		expiresAt: number;
	} | null;
	temporarySpeed: {
		clientId: string;
		gestureId: string;
		previousSpeed: number;
		expiresAt: number;
	} | null;
	votes: Record<string, string[]>;
	votesToSkip: string[];
	enableVoteSkip: boolean;
	createdAt: number;
}

export function createSnapshot(
	options: {
		name: string;
		title?: string;
		description?: string;
		isTemporary?: boolean;
		visibility?: Visibility;
		queueMode?: QueueMode;
	},
	owner: GuestSession,
): Snapshot {
	return {
		version: 1,
		name: options.name,
		title: options.title || options.name,
		description: options.description ?? "",
		isTemporary: options.isTemporary ?? true,
		visibility: options.visibility ?? Visibility.Unlisted,
		queueMode: options.queueMode ?? QueueMode.Manual,
		ownerId: owner.identity_id,
		roles: {},
		grants: new Grants().toJSON(),
		currentSource: null,
		queue: [],
		isPlaying: false,
		position: 0,
		anchorAt: Date.now(),
		playbackSpeed: 1,
		resumeOnNextJoin: false,
		emptySince: Date.now(),
		preparation: null,
		temporarySpeed: null,
		votes: {},
		votesToSkip: [],
		enableVoteSkip: false,
		createdAt: Date.now(),
	};
}

export function sameVideo(a: VideoId | null, b: VideoId | null): boolean {
	return a !== null && b !== null && a.service === b.service && a.id === b.id;
}
const keyFor = (video: VideoId) => video.service + video.id;
const rank = (role: Role) => (role === Role.Owner ? 100 : role);

/** Pure room rules; no Node process, background timer, database or network dependency. */
export class RoomState {
	members = new Map<string, Member>();
	dirty = new Set<keyof ServerMessageSync>();
	messages: ServerMessage[] = [];
	kicks: string[] = [];

	constructor(public snapshot: Snapshot) {}

	role(session: GuestSession): Role {
		return session.identity_id === this.snapshot.ownerId
			? Role.Owner
			: (this.snapshot.roles[session.identity_id] ?? Role.UnregisteredUser);
	}
	info(member: Member): RoomUserInfo {
		return {
			id: member.id,
			name: member.session.username,
			isLoggedIn: false,
			status: member.status,
			role: this.role(member.session),
		};
	}
	get users(): RoomUserInfo[] {
		return [...this.members.values()].map(member => this.info(member));
	}
	get grants(): Grants {
		return new Grants(this.snapshot.grants);
	}
	can(session: GuestSession, permission: string): boolean {
		return this.grants.granted(this.role(session), permission);
	}
	check(session: GuestSession, permission: string): void {
		if (!this.can(session, permission)) {
			throw new ApiError(403, "你没有执行此操作的房间权限。", "PermissionDeniedException");
		}
	}
	checkCommand(command: Command, member: Member): void {
		const permission = commandPermissions[command.type];
		if (permission) {
			this.check(member.session, permission);
		}
	}
	position(now = Date.now()): number {
		const s = this.snapshot;
		const position =
			s.position +
			(s.isPlaying ? (Math.max(0, now - s.anchorAt) / 1000) * s.playbackSpeed : 0);
		return Math.max(0, position);
	}
	private mark(...keys: (keyof ServerMessageSync)[]): void {
		for (const key of keys) {
			this.dirty.add(key);
		}
	}
	private anchor(position = this.position(), now = Date.now()): void {
		this.snapshot.position = position;
		this.snapshot.anchorAt = now;
	}
	private playing(value: boolean): void {
		this.anchor();
		this.snapshot.isPlaying = value;
		this.mark("isPlaying", "playbackPosition");
	}
	private clearPreparation(): void {
		if (this.snapshot.preparation) {
			this.snapshot.preparation = null;
			this.mark("playbackPreparation");
		}
	}
	private clearTemporarySpeed(): void {
		const previous = this.snapshot.temporarySpeed;
		if (!previous) {
			return;
		}
		this.anchor();
		this.snapshot.playbackSpeed = previous.previousSpeed;
		this.snapshot.temporarySpeed = null;
		this.mark("temporaryPlaybackSpeed", "playbackSpeed", "playbackPosition");
	}
	private prepare(exclude?: string): void {
		const s = this.snapshot;
		if (!s.resumeOnNextJoin || s.isPlaying || !s.currentSource || s.preparation) {
			return;
		}
		const member = [...this.members.values()].find(
			member => member.id !== exclude && this.can(member.session, "playback.play-pause"),
		);
		if (!member) {
			return;
		}
		s.preparation = {
			id: crypto.randomUUID(),
			clientId: member.id,
			video: { service: s.currentSource.service, id: s.currentSource.id },
			position: this.position(),
			expiresAt: Date.now() + 30_000,
		};
		this.mark("playbackPreparation", "playbackPosition", "isPlaying");
	}

	join(member: Member): void {
		this.members.set(member.id, member);
		this.snapshot.emptySince = null;
		this.messages.push({
			action: "user",
			update: { kind: "update", value: this.info(member) },
		});
		this.event(
			{ type: R.JoinRequest, info: { id: member.id, username: member.session.username } },
			member,
		);
		this.prepare();
	}
	leave(id: string): void {
		const member = this.members.get(id);
		if (!member) {
			return;
		}
		this.event({ type: R.LeaveRequest }, member, { user: this.info(member) });
		this.members.delete(id);
		this.messages.push({ action: "user", update: { kind: "remove", value: id } });
		for (const [key, ids] of Object.entries(this.snapshot.votes)) {
			this.snapshot.votes[key] = ids.filter(value => value !== id);
		}
		this.snapshot.votesToSkip = this.snapshot.votesToSkip.filter(value => value !== id);
		this.mark("voteCounts", "votesToSkip");
		this.orderVotes();
		if (this.snapshot.temporarySpeed?.clientId === id) {
			this.clearTemporarySpeed();
		}
		if (this.snapshot.preparation?.clientId === id) {
			this.clearPreparation();
		}
		if (this.members.size === 0) {
			this.snapshot.resumeOnNextJoin ||= this.snapshot.isPlaying;
			this.playing(false);
			this.snapshot.emptySince = Date.now();
		} else {
			this.prepare();
		}
	}

	/** A real runtime restart can lose all sockets. Resume from the last saved checkpoint. */
	recover(): void {
		if (this.members.size === 0) {
			const s = this.snapshot;
			s.resumeOnNextJoin ||= s.isPlaying || s.preparation !== null;
			s.isPlaying = false;
			s.anchorAt = Date.now();
			s.emptySince ??= Date.now();
			this.clearPreparation();
			if (s.temporarySpeed) {
				s.playbackSpeed = s.temporarySpeed.previousSpeed;
				s.temporarySpeed = null;
			}
		} else if (
			this.snapshot.preparation &&
			!this.members.has(this.snapshot.preparation.clientId)
		) {
			this.clearPreparation();
			this.prepare();
		}
	}

	status(member: Member, status: PlayerStatus, prepared?: PlaybackPrepared): void {
		member.status = status;
		this.messages.push({
			action: "user",
			update: { kind: "update", value: this.info(member) },
		});
		const s = this.snapshot;
		const preparation = s.preparation;
		if (
			!preparation ||
			preparation.clientId !== member.id ||
			prepared?.id !== preparation.id ||
			status !== PlayerStatus.ready ||
			preparation.expiresAt <= Date.now() ||
			!Number.isFinite(prepared.position) ||
			Math.abs(prepared.position - preparation.position) > 1.5 ||
			!sameVideo(s.currentSource, preparation.video) ||
			!this.can(member.session, "playback.play-pause")
		) {
			return;
		}
		this.clearPreparation();
		s.resumeOnNextJoin = false;
		this.playing(true);
	}

	private start(video: QueueItem | null): void {
		this.clearTemporarySpeed();
		this.clearPreparation();
		const s = this.snapshot;
		s.currentSource = video;
		s.playbackSpeed = 1;
		s.position = video?.startAt ?? 0;
		s.anchorAt = Date.now();
		s.isPlaying = video !== null && this.members.size > 0;
		s.resumeOnNextJoin = video !== null && this.members.size === 0;
		s.votesToSkip = [];
		this.mark(
			"currentSource",
			"playbackPosition",
			"isPlaying",
			"playbackSpeed",
			"votesToSkip",
			"playbackPreparation",
		);
	}
	private next(): void {
		const s = this.snapshot;
		if (s.queueMode === QueueMode.Loop && s.currentSource) {
			s.queue.push(s.currentSource);
		}
		const next = s.queue.shift() ?? null;
		if (next) {
			delete s.votes[keyFor(next)];
		}
		this.start(next);
		this.mark("queue", "voteCounts");
	}
	private orderVotes(): void {
		if (this.snapshot.queueMode !== QueueMode.Vote) {
			return;
		}
		this.snapshot.queue.sort(
			(a, b) =>
				(this.snapshot.votes[keyFor(b)]?.length ?? 0) -
				(this.snapshot.votes[keyFor(a)]?.length ?? 0),
		);
		this.mark("queue");
	}
	private checkQueueSize(queue: QueueItem[], current = this.snapshot.currentSource): void {
		if (
			queue.length > 200 ||
			new TextEncoder().encode(JSON.stringify([current, ...queue])).byteLength > 512 * 1024
		) {
			throw new ApiError(400, "队列已达到容量上限，请先移除部分待播视频。");
		}
	}
	private event(
		request: unknown,
		member: Member,
		additional: Record<string, unknown> = {},
	): void {
		this.messages.push({
			action: "event",
			request,
			user: { name: member.session.username, isLoggedIn: false },
			additional,
		} as ServerMessage);
	}

	apply(command: Command, member: Member, resolved: QueueItem[] = []): void {
		this.checkCommand(command, member);
		const s = this.snapshot;
		let additional: Record<string, unknown> = {};
		switch (command.type) {
			case R.ChatRequest:
				this.messages.push({ action: "chat", from: this.info(member), text: command.text });
				return;
			case R.PlaybackRequest:
				if (!s.currentSource) {
					return;
				}
				this.clearPreparation();
				s.resumeOnNextJoin = false;
				this.playing(command.state);
				break;
			case R.SeekRequest: {
				if (!s.currentSource) {
					throw new ApiError(400, "当前没有视频。");
				}
				const end = s.currentSource.endAt ?? s.currentSource.length;
				if (end !== undefined && command.value > end) {
					throw new ApiError(400, "跳转位置超过视频时长。");
				}
				additional = { prevPosition: this.position() };
				this.anchor(command.value);
				this.mark("playbackPosition");
				if (s.preparation) {
					this.clearPreparation();
					this.prepare();
				}
				break;
			}
			case R.SkipRequest:
				if (s.enableVoteSkip && rank(this.role(member.session)) < Role.Moderator) {
					if (!s.votesToSkip.includes(member.id)) {
						s.votesToSkip.push(member.id);
					}
					this.mark("votesToSkip");
					if (s.votesToSkip.length <= this.members.size / 2) {
						return;
					}
				}
				additional = { video: s.currentSource, prevPosition: this.position() };
				this.next();
				break;
			case R.AddRequest:
				if (!resolved.length || s.queue.length + resolved.length > 200) {
					throw new ApiError(400, "队列最多可保存 200 个待播视频。");
				}
				this.checkQueueSize([...s.queue, ...resolved]);
				s.queue.push(...resolved);
				additional = { videos: resolved };
				this.mark("queue");
				this.orderVotes();
				if (!s.currentSource) {
					this.next();
				}
				break;
			case R.RemoveRequest: {
				const index = s.queue.findIndex(video => sameVideo(video, command.video));
				if (index < 0) {
					throw new ApiError(404, "待播队列中没有该视频。");
				}
				additional = { video: s.queue[index], queueIdx: index };
				s.queue.splice(index, 1);
				delete s.votes[keyFor(command.video)];
				this.mark("queue", "voteCounts");
				break;
			}
			case R.OrderRequest:
				if (command.fromIdx >= s.queue.length || command.toIdx >= s.queue.length) {
					throw new ApiError(400, "队列位置无效。");
				}
				s.queue.splice(command.toIdx, 0, s.queue.splice(command.fromIdx, 1)[0]);
				this.mark("queue");
				break;
			case R.VoteRequest: {
				if (!s.queue.some(video => sameVideo(video, command.video))) {
					throw new ApiError(404, "待播队列中没有该视频。");
				}
				const key = keyFor(command.video);
				const votes = new Set(s.votes[key] ?? []);
				if (command.add) {
					votes.add(member.id);
				} else {
					votes.delete(member.id);
				}
				s.votes[key] = [...votes];
				this.mark("voteCounts");
				this.orderVotes();
				break;
			}
			case R.PlayNowRequest: {
				if (sameVideo(s.currentSource, command.video)) {
					return;
				}
				const video = resolved[0];
				if (!video) {
					throw new ApiError(400, "未取得视频信息。");
				}
				const queue = s.queue.filter(item => !sameVideo(item, command.video));
				if (s.currentSource) {
					queue.unshift(s.currentSource);
				}
				this.checkQueueSize(queue, video);
				s.queue = queue;
				delete s.votes[keyFor(command.video)];
				this.start(video);
				this.mark("queue", "voteCounts");
				break;
			}
			case R.ShuffleRequest:
				for (let i = s.queue.length - 1; i > 0; i--) {
					const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
					[s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
				}
				this.mark("queue");
				break;
			case R.PlaybackSpeedRequest:
				this.clearTemporarySpeed();
				this.anchor();
				s.playbackSpeed = command.speed;
				this.mark("playbackSpeed", "playbackPosition");
				break;
			case R.TemporaryPlaybackSpeedRequest: {
				if (!sameVideo(s.currentSource, command.video)) {
					return;
				}
				const active = s.temporarySpeed;
				const owned =
					active?.clientId === member.id && active.gestureId === command.gestureId;
				if (command.action === "stop") {
					if (owned) {
						this.clearTemporarySpeed();
					}
					return;
				}
				if (command.action === "renew") {
					if (owned) {
						active.expiresAt = Date.now() + 5000;
					}
					return;
				}
				if (!s.isPlaying || (active && !owned)) {
					return;
				}
				if (!active) {
					this.anchor();
					s.temporarySpeed = {
						clientId: member.id,
						gestureId: command.gestureId,
						previousSpeed: s.playbackSpeed,
						expiresAt: Date.now() + 5000,
					};
					s.playbackSpeed = 2;
					this.mark("playbackPosition", "playbackSpeed", "temporaryPlaybackSpeed");
				}
				return;
			}
			case R.UpdateQueueItemRequest: {
				const index = s.queue.findIndex(item => sameVideo(item, command.video));
				if (index < 0 || !resolved[0]) {
					throw new ApiError(404, "待播队列中没有该视频。");
				}
				const queue = [...s.queue];
				queue[index] = { ...s.queue[index], ...resolved[0] };
				this.checkQueueSize(queue);
				s.queue = queue;
				this.mark("queue");
				break;
			}
			case R.PromoteRequest: {
				const target = this.members.get(command.targetClientId);
				if (
					!target ||
					command.role === Role.Owner ||
					this.role(target.session) === Role.Owner ||
					rank(this.role(member.session)) <=
						Math.max(rank(this.role(target.session)), rank(command.role))
				) {
					throw new ApiError(403, "不能修改该用户的权限。");
				}
				const names: Partial<Record<Role, string>> = {
					[Role.Administrator]: "admin",
					[Role.Moderator]: "moderator",
					[Role.TrustedUser]: "trusted-user",
				};
				const old = this.role(target.session);
				if (names[old]) {
					this.check(member.session, `manage-users.demote-${names[old]}`);
				}
				if (names[command.role]) {
					this.check(member.session, `manage-users.promote-${names[command.role]}`);
				}
				if (
					!(target.session.identity_id in s.roles) &&
					Object.keys(s.roles).length >= 500
				) {
					throw new ApiError(400, "此房间保存的用户角色已达到上限。");
				}
				s.roles[target.session.identity_id] = command.role;
				for (const peer of this.members.values()) {
					if (peer.session.identity_id === target.session.identity_id) {
						this.messages.push({
							action: "user",
							update: { kind: "update", value: this.info(peer) },
						});
					}
				}
				if (
					s.preparation?.clientId === target.id &&
					!this.can(target.session, "playback.play-pause")
				) {
					this.clearPreparation();
					this.prepare();
				}
				break;
			}
			case R.KickRequest: {
				const target = this.members.get(command.clientId);
				if (!target || rank(this.role(member.session)) <= rank(this.role(target.session))) {
					throw new ApiError(403, "不能移出该用户。");
				}
				this.kicks.push(target.id);
				this.leave(target.id);
				break;
			}
			case R.ApplySettingsRequest:
				this.settings(command, member);
				break;
			case R.RestoreQueueRequest:
				// This backend retains the active item and queue directly between visits.
				return;
		}
		this.event(command, member, additional);
	}

	private settings(
		command: Extract<Command, { type: R.ApplySettingsRequest }>,
		member: Member,
	): void {
		const settings = command.settings;
		const grants = settings.grants ? new Grants(settings.grants) : null;
		const grantsChanged = grants
			?.toJSON()
			.some(([role, mask]) => mask !== this.grants.getMask(role));
		const permissions: Record<string, string> = {
			title: "configure-room.set-title",
			description: "configure-room.set-description",
			visibility: "configure-room.set-visibility",
			queueMode: "configure-room.set-queue-mode",
		};
		for (const key of Object.keys(settings)) {
			if (key === "grants") {
				if (grantsChanged && this.role(member.session) !== Role.Owner) {
					throw new ApiError(403, "此测试版由房主调整房间权限。");
				}
			} else {
				this.check(member.session, permissions[key] ?? "configure-room.other");
			}
		}
		if (
			settings.visibility === Visibility.Private ||
			settings.queueMode === QueueMode.Dj ||
			settings.autoSkipSegmentCategories?.length ||
			(settings.restoreQueueBehavior !== undefined &&
				settings.restoreQueueBehavior !== BehaviorOption.Always)
		) {
			throw new ApiError(400, "此测试版暂不支持私人账号房间、DJ 队列和自动跳广告。");
		}
		for (const key of [
			"title",
			"description",
			"visibility",
			"queueMode",
			"enableVoteSkip",
		] as const) {
			if (settings[key] !== undefined) {
				Object.assign(this.snapshot, { [key]: settings[key] });
				this.mark(key);
			}
		}
		if (grantsChanged && grants) {
			this.snapshot.grants = grants.toJSON();
			this.mark("grants");
			const preparer = this.members.get(this.snapshot.preparation?.clientId ?? "");
			if (preparer && !this.can(preparer.session, "playback.play-pause")) {
				this.clearPreparation();
			}
			this.prepare();
		}
		this.orderVotes();
	}

	/** Alarm events replace the original process-wide one-second interval. */
	tick(): void {
		const s = this.snapshot;
		if (s.temporarySpeed && s.temporarySpeed.expiresAt <= Date.now()) {
			this.clearTemporarySpeed();
		}
		if (s.preparation && s.preparation.expiresAt <= Date.now()) {
			const previous = s.preparation.clientId;
			this.clearPreparation();
			this.prepare(previous);
		}
		const end = s.currentSource?.endAt ?? s.currentSource?.length;
		if (s.currentSource && s.isPlaying && end !== undefined && this.position() >= end) {
			this.next();
		}
	}

	fullSync(): ServerMessageSync {
		const s = this.snapshot;
		return {
			action: "sync",
			name: s.name,
			title: s.title,
			description: s.description,
			isTemporary: s.isTemporary,
			visibility: s.visibility,
			queueMode: s.queueMode,
			isPlaying: s.isPlaying,
			playbackPosition: this.position(),
			playbackSpeed: s.playbackSpeed,
			currentSource: s.currentSource,
			queue: s.queue,
			prevQueue: null,
			hasOwner: true,
			grants: s.grants,
			voteCounts: Object.entries(s.votes).map(([key, ids]) => [key, ids.length]),
			votesToSkip: s.votesToSkip,
			enableVoteSkip: s.enableVoteSkip,
			autoSkipSegmentCategories: [],
			videoSegments: [],
			restoreQueueBehavior: BehaviorOption.Always,
			playbackPreparation: s.preparation
				? {
						id: s.preparation.id,
						clientId: s.preparation.clientId,
						video: s.preparation.video,
						position: s.preparation.position,
					}
				: null,
			temporaryPlaybackSpeed: s.temporarySpeed
				? {
						clientId: s.temporarySpeed.clientId,
						gestureId: s.temporarySpeed.gestureId,
						speed: 2,
					}
				: null,
		};
	}
	drain(): { messages: ServerMessage[]; kicks: string[] } {
		const messages = this.messages;
		if (this.dirty.size) {
			const full = this.fullSync();
			const sync: Record<string, unknown> = { action: "sync" };
			for (const key of this.dirty) {
				sync[key] = full[key];
			}
			messages.push(sync as unknown as ServerMessageSync);
		}
		const kicks = this.kicks;
		this.dirty.clear();
		this.messages = [];
		this.kicks = [];
		return { messages, kicks };
	}
	persisted(): Snapshot {
		this.anchor();
		return structuredClone(this.snapshot);
	}
	nextAlarm(idleMs: number): number | null {
		const s = this.snapshot;
		const times: number[] = [];
		if (s.isTemporary && s.emptySince !== null) {
			times.push(s.emptySince + idleMs);
		}
		if (s.temporarySpeed) {
			times.push(s.temporarySpeed.expiresAt);
		}
		if (s.preparation) {
			times.push(s.preparation.expiresAt);
		}
		if (s.isPlaying && this.members.size) {
			times.push(s.anchorAt + 30_000); // Status/chat traffic must not postpone the checkpoint.
			const end = s.currentSource?.endAt ?? s.currentSource?.length;
			if (end !== undefined) {
				times.push(
					Date.now() + Math.max(1, ((end - this.position()) / s.playbackSpeed) * 1000),
				);
			}
		}
		return times.length ? Math.max(Date.now() + 1, Math.min(...times)) : null;
	}
}
