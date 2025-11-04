import { getSupabaseClient } from '../supabase';
import { fetchModerationConfig } from './config';
import type {
  EscalationRule,
  ModerationCaseInput,
  ModerationCaseRecord,
  ModerationCaseResponse,
  ModerationEscalationResult,
} from './types';

function normalizeCaseRecord(record: Record<string, unknown>): ModerationCaseRecord {
  return {
    id: String(record.id),
    case_number: (record.case_number as number | null) ?? null,
    guild_id: String(record.guild_id),
    type: record.type as ModerationCaseRecord['type'],
    reason: String(record.reason ?? ''),
    target_id: String(record.target_id),
    target_tag: String(record.target_tag),
    moderator_id: String(record.moderator_id),
    moderator_tag: String(record.moderator_tag),
    severity: (record.severity as ModerationCaseRecord['severity']) ?? null,
    duration_ms: (record.duration_ms as number | null) ?? null,
    metadata: (record.metadata as Record<string, unknown> | null) ?? null,
    created_at: String(record.created_at ?? new Date().toISOString()),
    resolved_at: (record.resolved_at as string | null) ?? null,
  };
}

async function hasEscalationBeenApplied(
  guildId: string,
  targetId: string,
  rule: EscalationRule,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('moderation_cases')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('target_id', targetId)
    .eq('type', 'escalation')
    .contains('metadata', { ruleId: rule.id });

  if (error) {
    console.error('[moderation-case] Failed to check escalation state:', error);
    return false;
  }

  return (count ?? 0) > 0;
}

async function getWarnCount(guildId: string, targetId: string): Promise<number> {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('moderation_cases')
    .select('id', { head: true, count: 'exact' })
    .eq('guild_id', guildId)
    .eq('target_id', targetId)
    .eq('type', 'warn');

  if (error) {
    console.error('[moderation-case] Failed to count warns:', error);
    return 0;
  }

  return count ?? 0;
}

async function createEscalationCase(
  guildId: string,
  targetId: string,
  targetTag: string,
  moderatorId: string,
  moderatorTag: string,
  rule: EscalationRule,
  triggerCount: number,
  sourceCaseId: string,
): Promise<ModerationCaseRecord | null> {
  const supabase = getSupabaseClient();
  const payload = {
    guild_id: guildId,
    type: 'escalation',
    reason: rule.action.reason,
    target_id: targetId,
    target_tag: targetTag,
    moderator_id: moderatorId,
    moderator_tag: moderatorTag,
    metadata: {
      ruleId: rule.id,
      triggerCount,
      sourceCaseId,
    },
  };

  const { data, error } = await supabase
    .from('moderation_cases')
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[moderation-case] Failed to create escalation case:', error);
    return null;
  }

  if (!data) {
    return null;
  }

  return normalizeCaseRecord(data as Record<string, unknown>);
}

async function resolveWarnEscalation(
  caseRecord: ModerationCaseRecord,
): Promise<ModerationEscalationResult | null> {
  const config = await fetchModerationConfig(caseRecord.guild_id);
  const rules = [...config.escalation.warn].sort((a, b) => b.threshold - a.threshold);
  if (!rules.length) {
    return null;
  }

  const warnCount = await getWarnCount(caseRecord.guild_id, caseRecord.target_id);

  for (const rule of rules) {
    if (warnCount < rule.threshold) {
      continue;
    }

    const alreadyApplied = await hasEscalationBeenApplied(caseRecord.guild_id, caseRecord.target_id, rule);
    if (alreadyApplied) {
      continue;
    }

    const escalationCase = await createEscalationCase(
      caseRecord.guild_id,
      caseRecord.target_id,
      caseRecord.target_tag,
      caseRecord.moderator_id,
      caseRecord.moderator_tag,
      rule,
      warnCount,
      caseRecord.id,
    );

    if (!escalationCase) {
      return null;
    }

    return {
      rule,
      action: rule.action,
      triggerCount: warnCount,
      caseRecord: escalationCase,
    };
  }

  return null;
}

export async function createModerationCase(
  input: ModerationCaseInput,
): Promise<ModerationCaseResponse> {
  const supabase = getSupabaseClient();
  const payload = {
    guild_id: input.guildId,
    type: input.type,
    reason: input.reason,
    target_id: input.targetId,
    target_tag: input.targetTag,
    moderator_id: input.moderatorId,
    moderator_tag: input.moderatorTag,
    severity: input.severity ?? null,
    duration_ms: input.durationMs ?? null,
    metadata: input.metadata ?? null,
  };

  const { data, error } = await supabase
    .from('moderation_cases')
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[moderation-case] Failed to create case:', error);
    throw error;
  }

  if (!data) {
    throw new Error('No case data returned from Supabase');
  }

  const caseRecord = normalizeCaseRecord(data as Record<string, unknown>);

  if (input.type !== 'warn') {
    return { caseRecord };
  }

  const escalation = await resolveWarnEscalation(caseRecord);
  return { caseRecord, escalation };
}
