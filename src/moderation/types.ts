import type { APIEmbedField } from 'discord.js';

export type ModerationActionType =
  | 'warn'
  | 'mute'
  | 'timeout'
  | 'ban'
  | 'kick'
  | 'clear'
  | 'lock'
  | 'slowmode'
  | 'nick'
  | 'escalation';

export type ModerationSeverity = 'low' | 'medium' | 'high';

export type FilterSeverity = 'level1' | 'level2' | 'level3';

export type EscalationAction =
  | {
      kind: 'timeout';
      durationMs: number;
      reason: string;
    }
  | {
      kind: 'ban';
      reason: string;
    }
  | {
      kind: 'kick';
      reason: string;
    };

export interface EscalationRule {
  id: string;
  threshold: number;
  action: EscalationAction;
  note?: string;
}

export interface ModerationConfig {
  guildId: string;
  logChannels: {
    moderation?: string | null;
    cases?: string | null;
    joins?: string | null;
    leaves?: string | null;
    nameChanges?: string | null;
    avatarChanges?: string | null;
    messageDeletes?: string | null;
    messageEdits?: string | null;
    bans?: string | null;
    unbans?: string | null;
    timeouts?: string | null;
    roleChanges?: string | null;
  };
  escalation: {
    warn: EscalationRule[];
  };
  softActions: {
    allowLock: boolean;
    allowSlowmode: boolean;
    allowNick: boolean;
    defaultSlowmodeSeconds: number;
    defaultLockReason: string;
  };
  filters: {
    level: FilterSeverity;
    reviewQueueEnabled: boolean;
    actions: Record<FilterSeverity, EscalationAction>;
  };
  rateLimits: {
    messagesPerSecond: number;
    messagesPerMinute: number;
    capsPercentage: number;
    emojiLimit: number;
    mentionLimit: number;
  };
  raid: {
    spikeMemberCount: number;
    spikeIntervalMinutes: number;
    autoSlowmodeSeconds: number;
    autoLockDurationMinutes: number;
    requireVerification: boolean;
    captchaGate: boolean;
  };
  notifications: {
    dmOnAction: boolean;
    dmIncludeReason: boolean;
  };
  retention: {
    caseRetentionDays: number;
    logRetentionDays: number;
    anonymizeAfterDays: number | null;
  };
  permissions: {
    superAdminIds: string[];
    /**
     * Maps command names (e.g. "mute", "warn") to role ids that are explicitly allowed
     * to run the command. Empty arrays fall back to Discord permissions.
     */
    roleOverrides: Record<string, string[]>;
  };
  defaults: {
    timeoutMinutes: number;
    reasons: {
      warn: string[];
      mute: string[];
      ban: string[];
      kick: string[];
    };
  };
}

export interface ModerationCaseInput {
  guildId: string;
  type: ModerationActionType;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  moderatorTag: string;
  reason: string;
  severity?: ModerationSeverity;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface ModerationCaseRecord {
  id: string;
  case_number?: number | null;
  guild_id: string;
  type: ModerationActionType;
  reason: string;
  target_id: string;
  target_tag: string;
  moderator_id: string;
  moderator_tag: string;
  severity?: ModerationSeverity | null;
  duration_ms?: number | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface ModerationCaseResponse {
  caseRecord: ModerationCaseRecord;
  escalation?: ModerationEscalationResult | null;
}

export interface ModerationEscalationResult {
  rule: EscalationRule;
  action: EscalationAction;
  triggerCount: number;
  caseRecord: ModerationCaseRecord;
}

export interface ModerationCaseLogOptions {
  additionalFields?: APIEmbedField[];
}

export type ModerationLogCategory =
  | 'moderation'
  | 'cases'
  | 'joins'
  | 'leaves'
  | 'nameChanges'
  | 'avatarChanges'
  | 'messageDeletes'
  | 'messageEdits'
  | 'bans'
  | 'unbans'
  | 'timeouts'
  | 'roleChanges';

export type ModerationConfigPatch = DeepPartial<ModerationConfig>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends Array<infer U>
      ? Array<DeepPartial<U>>
      : DeepPartial<T[K]>
    : T[K];
};
