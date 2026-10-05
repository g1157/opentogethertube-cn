import { PermissionDeniedException, InvalidRoleException } from "./exceptions.js";
import { Role } from "./models/types.js";

export type GrantMask = number;
export type PermissionName = string;
/**
 * The old format for mapping roles to grant masks
 * @deprecated
 */
export type OldRoleGrants = {
	[P in keyof typeof Role]?: GrantMask;
};
/**
 * A type that represents a mapping from a Role to the permission grants that the role has.
 */
export type RoleGrants = Map<Role, GrantMask>;

export const ROLE_NAMES: { [P in keyof typeof Role]?: string } = {
	[Role.Administrator]: "admin",
	[Role.Moderator]: "mod",
	[Role.TrustedUser]: "trusted",
	[Role.RegisteredUser]: "registered",
	[Role.UnregisteredUser]: "unregistered",
	[Role.Owner]: "owner",
};

export const ROLE_DISPLAY_NAMES: { [P in keyof typeof Role]?: string } = {
	[Role.Administrator]: "Administrator",
	[Role.Moderator]: "Moderator",
	[Role.TrustedUser]: "Trusted User",
	[Role.RegisteredUser]: "Registered User",
	[Role.UnregisteredUser]: "Unregistered User",
	[Role.Owner]: "Owner",
};

export class Permission {
	name: PermissionName;
	mask: GrantMask;
	minRole: Role;

	constructor(args: Partial<{ name: PermissionName; mask: GrantMask; minRole: Role }>) {
		this.name = "";
		this.mask = 0;
		this.minRole = Role.UnregisteredUser;
		Object.assign(this, args);
	}
}

export const PERMISSIONS = [
	new Permission({ name: "playback.play-pause", mask: 1 << 0, minRole: Role.UnregisteredUser }),
	new Permission({ name: "playback.skip", mask: 1 << 1, minRole: Role.UnregisteredUser }),
	new Permission({ name: "playback.seek", mask: 1 << 2, minRole: Role.UnregisteredUser }),
	new Permission({ name: "manage-queue.add", mask: 1 << 3, minRole: Role.UnregisteredUser }),
	new Permission({ name: "manage-queue.remove", mask: 1 << 4, minRole: Role.RegisteredUser }),
	new Permission({ name: "manage-queue.order", mask: 1 << 5, minRole: Role.UnregisteredUser }),
	new Permission({ name: "manage-queue.vote", mask: 1 << 6, minRole: Role.UnregisteredUser }),
	new Permission({ name: "chat", mask: 1 << 7, minRole: Role.UnregisteredUser }),
	new Permission({
		name: "configure-room.set-title",
		mask: 1 << 8,
		minRole: Role.RegisteredUser,
	}),
	new Permission({
		name: "configure-room.set-description",
		mask: 1 << 9,
		minRole: Role.RegisteredUser,
	}),
	new Permission({
		name: "configure-room.set-visibility",
		mask: 1 << 10,
		minRole: Role.RegisteredUser,
	}),
	new Permission({
		name: "configure-room.set-queue-mode",
		mask: 1 << 11,
		minRole: Role.RegisteredUser,
	}),
	new Permission({
		name: "configure-room.set-permissions.for-moderator",
		mask: 1 << 12,
		minRole: Role.Administrator,
	}),
	new Permission({
		name: "configure-room.set-permissions.for-trusted-users",
		mask: 1 << 13,
		minRole: Role.Moderator,
	}),
	new Permission({
		name: "configure-room.set-permissions.for-all-registered-users",
		mask: 1 << 14,
		minRole: Role.TrustedUser,
	}),
	new Permission({
		name: "configure-room.set-permissions.for-all-unregistered-users",
		mask: 1 << 15,
		minRole: Role.RegisteredUser,
	}),
	// Permission to promote a user TO admin
	new Permission({
		name: "manage-users.promote-admin",
		mask: 1 << 16,
		minRole: Role.Administrator,
	}),
	// Permission to demote a user FROM admin
	new Permission({
		name: "manage-users.demote-admin",
		mask: 1 << 17,
		minRole: Role.Administrator,
	}),
	new Permission({
		name: "manage-users.promote-moderator",
		mask: 1 << 18,
		minRole: Role.Moderator,
	}),
	new Permission({
		name: "manage-users.demote-moderator",
		mask: 1 << 19,
		minRole: Role.Moderator,
	}),
	new Permission({
		name: "manage-users.promote-trusted-user",
		mask: 1 << 20,
		minRole: Role.TrustedUser,
	}),
	new Permission({
		name: "manage-users.demote-trusted-user",
		mask: 1 << 21,
		minRole: Role.TrustedUser,
	}),
	new Permission({
		name: "configure-room.other",
		mask: 1 << 22,
		minRole: Role.RegisteredUser,
	}),
	new Permission({
		name: "playback.speed",
		mask: 1 << 23,
		minRole: Role.UnregisteredUser,
	}),
	new Permission({
		name: "manage-users.kick",
		mask: 1 << 24,
		minRole: Role.TrustedUser,
	}),
	new Permission({
		name: "manage-queue.play-now",
		mask: 1 << 25,
		minRole: Role.UnregisteredUser,
	}),
	new Permission({
		name: "manage-queue.edit",
		mask: 1 << 26,
		minRole: Role.UnregisteredUser,
	}),
	new Permission({
		name: "configure-room.set-notes",
		mask: 1 << 27,
		minRole: Role.UnregisteredUser,
	}),
	// Everyone may point the room at a danmaku track by default (the same posture as the
	// other "other" settings); the room owner can tighten the grants if it turns into a
	// tug of war.
	new Permission({
		name: "configure-room.set-danmaku-source",
		mask: 1 << 28,
		minRole: Role.UnregisteredUser,
	}),
];

const permMaskMap = new Map(PERMISSIONS.map(p => [p.name, p.mask]));

/**
 * Get the default permissions.
 * @deprecated
 */
function defaultPermissions(): Grants {
	return new Grants({
		[Role.UnregisteredUser]: parseIntoGrantMask([
			"playback",
			"manage-queue.add",
			"manage-queue.order",
			"manage-queue.vote",
			"manage-queue.play-now",
			"manage-queue.edit",
			"chat",
			"configure-room.set-notes",
			"configure-room.set-danmaku-source",
		]),
		[Role.RegisteredUser]: parseIntoGrantMask([
			"manage-queue.remove",
			"configure-room.set-title",
			"configure-room.set-description",
			"configure-room.set-visibility",
			"configure-room.set-queue-mode",
			"configure-room.other",
		]),
		[Role.TrustedUser]: parseIntoGrantMask([]),
		[Role.Moderator]: parseIntoGrantMask([
			"manage-users.promote-trusted-user",
			"manage-users.demote-trusted-user",
			"manage-users.kick",
		]),
		[Role.Administrator]: parseIntoGrantMask(["*"]),
		[Role.Owner]: parseIntoGrantMask(["*"]),
	});
}

/**
 * Creates a deterministic mask given a list of string form permissions.
 */
export function parseIntoGrantMask(perms: PermissionName[]): GrantMask {
	if (!Array.isArray(perms)) {
		throw new TypeError(`perms must be an array of strings, got ${typeof perms}`);
	}
	let mask = 0;
	for (const perm of perms) {
		permMaskMap.forEach((value, key) => {
			if (key.startsWith(perm) || perm === "*") {
				mask |= value;
			}
		});
	}
	return mask;
}

/**
 * Get a mask of permissions that are allowed for the given role, based on stuff like minRole.
 */
function getValidationMask(role: Role): GrantMask {
	const masks = PERMISSIONS.filter(p => role >= p.minRole).map(p => p.mask);
	if (masks.length === 0) {
		return parseIntoGrantMask(["*"]);
	}
	return masks.reduce((full, mask) => full | mask);
}

/**
 * Check if the given role is valid.
 */
function isRoleValid(role: Role) {
	if (typeof role === "number") {
		return -1 <= role && role <= 4;
	} else {
		return false;
	}
}

function _normalizeRoleId(role: Role | string | number): Role {
	if (typeof role === "string") {
		role = parseInt(role);
	}
	return role;
}

/**
 * Represents permissions for all roles. Handles permission inheritance, and serialization/deserialization.
 * If grants are not provided, the defaults will be used.
 */
export class Grants {
	masks: RoleGrants = new Map();

	/**
	 * @param {Object|undefined} grants Optional object that maps roles to grant masks.
	 */
	constructor(
		grants: Grants | RoleGrants | OldRoleGrants | [Role, GrantMask][] | undefined = undefined,
	) {
		if (!grants) {
			grants = defaultPermissions();
		}
		this.setAllGrants(grants);
		// HACK: force owner to always have all permissions
		this.setRoleGrants(Role.Administrator, parseIntoGrantMask(["*"]));
		this.setRoleGrants(Role.Owner, parseIntoGrantMask(["*"]));
	}

	getMask(role: Role): GrantMask {
		return this.masks.get(role)!;
	}

	/**
	 * Clears all grant masks and replaces them with `grants`.
	 * @param grants Optional object that maps roles to grant masks.
	 */
	setAllGrants(grants: RoleGrants | Grants | OldRoleGrants | [Role, GrantMask][]): void {
		this.masks = new Map();
		if (Array.isArray(grants)) {
			grants = new Map(grants);
		}
		if (grants instanceof Grants) {
			this.setAllGrants(grants.masks);
		} else if (grants instanceof Map) {
			for (const role of grants.keys()) {
				const mask = grants.get(role);
				if (!mask) {
					continue;
				}
				this.setRoleGrants(role, mask);
			}
		} else {
			for (const r in grants) {
				const role = _normalizeRoleId(r);
				if (Object.hasOwn(grants, role)) {
					this.setRoleGrants(role, grants[role]!);
				}
			}
		}
	}

	/**
	 * @returns Grant bitmask
	 */
	private _normalizePermissionsInput(permissions: PermissionName[] | GrantMask): GrantMask {
		if (Array.isArray(permissions)) {
			permissions = parseIntoGrantMask(permissions);
		}
		return permissions;
	}

	/**
	 * @throws InvalidRoleException
	 */
	setRoleGrants(role: Role, permissions: PermissionName[] | GrantMask): void {
		role = _normalizeRoleId(role);
		if (!isRoleValid(role)) {
			throw new InvalidRoleException(role);
		}
		permissions = this._normalizePermissionsInput(permissions);
		const validation = getValidationMask(role);
		this.masks.set(role, permissions & validation);
		this._processInheiritance();
	}

	private _processInheiritance(): void {
		let fullmask: GrantMask = 0;
		for (let i = Role.UnregisteredUser; i <= Role.Administrator; i++) {
			fullmask |= this.getMask(i);
			this.masks.set(i, fullmask);
		}
	}

	/**
	 * Checks if the given role is granted the permission, given the grants.
	 */
	granted(role: Role, permission: Permission | PermissionName): boolean {
		role = _normalizeRoleId(role);
		let checkmask: GrantMask;
		if (permission instanceof Permission) {
			checkmask = permission.mask;
		} else if (typeof permission === "string") {
			checkmask = parseIntoGrantMask([permission]);
		} else {
			return false;
		}
		const fullmask = this.getMask(role);
		const isGranted = (fullmask & checkmask) === checkmask;
		return isGranted;
	}

	/**
	 * Checks to see if the permission is granted. Throws an exception if it fails.
	 * @throws PermissionDeniedException
	 */
	check(role: Role, permission: Permission | PermissionName): void {
		role = _normalizeRoleId(role);
		if (!this.granted(role, permission)) {
			let name: string;
			if (permission instanceof Permission) {
				name = permission.name;
			} else {
				name = permission;
			}
			throw new PermissionDeniedException(name);
		}
	}

	/**
	 * Keep only the specified roles, delete all other grant masks.
	 */
	filterRoles(roles: Role[]): void {
		for (const role of this.masks.keys()) {
			if (!roles.includes(role)) {
				this.deleteRole(role);
			}
		}
	}

	/**
	 * Get a list of all roles that are present in the grants.
	 * @returns
	 */
	getRoles(): Role[] {
		return Array.from(this.masks.keys());
	}

	get isEmpty(): boolean {
		return this.masks.size === 0;
	}

	deleteRole(role: Role): void {
		this.masks.delete(role);
	}

	/**
	 * Serialize grants to a string. Used to store grants in the database.
	 */
	serialize(): string {
		return JSON.stringify([...this.masks]);
	}

	/**
	 * Deserialize grants from a string.
	 */
	deserialize(value: string): void {
		const g = JSON.parse(value);
		this.setAllGrants(g);
		// HACK: force owner to always have all permissions.
		this.setRoleGrants(Role.Owner, parseIntoGrantMask(["*"]));
	}

	toJSON(): [Role, GrantMask][] {
		return [...this.masks];
	}
}

/**
 * The current round of default permissions. Rooms store their grants as masks, and a mask
 * saved before a permission existed never contains it — the DB row and the Redis snapshot
 * both keep whatever they were created with. Stamping a revision lets a loader re-grant
 * exactly the bits added since the snapshot was taken, once; tightening them afterwards
 * sticks, because the room then carries the current revision.
 */
export const ROOM_PERMISSIONS_REVISION = 1;

/** Permission bits introduced at each revision; earlier revisions are implied. */
const PERMISSION_ADDITIONS: Record<number, PermissionName[]> = {
	1: ["configure-room.set-danmaku-source"],
};

/** Grants the additions between `fromRevision` (exclusive) and the current revision. */
export function applyPermissionAdditions(grants: Grants, fromRevision: number): void {
	for (let revision = fromRevision + 1; revision <= ROOM_PERMISSIONS_REVISION; revision++) {
		const added = PERMISSION_ADDITIONS[revision];
		if (!added || added.length === 0) {
			continue;
		}
		// Only the baseline role needs the bits: the higher roles inherit from it, and
		// owner/administrator are always forced to hold everything.
		const baseline = grants.getMask(Role.UnregisteredUser) | parseIntoGrantMask(added);
		grants.setRoleGrants(Role.UnregisteredUser, baseline);
	}
}

const _exp = {
	ROLE_NAMES,
	ROLE_DISPLAY_NAMES,
	PERMISSIONS,
	Grants,
	defaultPermissions,
	parseIntoGrantMask,
	getValidationMask,
	ROOM_PERMISSIONS_REVISION,
	applyPermissionAdditions,
};
export default _exp;
