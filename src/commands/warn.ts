import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createModerationCase } from '../moderation/case-manager';
import { logModerationCase, sendModerationLog } from '../moderation/logging';
import { fetchModerationConfig } from '../moderation/config';
import type { ModerationCaseRecord } from '../moderation/types';
import type { CommandDef } from '../types/Command';

type WarnInteraction = ChatInputCommandInteraction<'cached'>;

type SeverityChoice = 'low' | 'medium' | 'high';

const SEVERITY_MAP: Record<SeverityChoice, string> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
};

const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Verwarnt einen Nutzer und protokolliert den Fall.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(option =>
    option
      .setName('spieler')
      .setDescription('Der Nutzer, der verwarnt werden soll.')
      .setRequired(true),
  )
  .addStringOption(option =>
    option
      .setName('grund')
      .setDescription('Grund für die Verwarnung.')
      .setRequired(true)
      .setMaxLength(512),
  )
  .addStringOption(option =>
    option
      .setName('schweregrad')
      .setDescription('Optionaler Schweregrad für den Fall.')
      .addChoices(
        { name: 'Niedrig', value: 'low' },
        { name: 'Mittel', value: 'medium' },
        { name: 'Hoch', value: 'high' },
      ),
  );

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<WarnInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Warn command invoked outside of guild.');
  }
  return interaction;
}

async function requireModeratorPermission(interaction: WarnInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Mitglieder moderieren", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ModerateMembers');
  }
}

function assertGuildMember(member: GuildMember | null): asserts member is GuildMember {
  if (!member) {
    throw new Error('Target member not found in guild cache.');
  }
}

async function maybeNotifyUser(
  member: GuildMember,
  moderatorTag: string,
  reason: string,
  severity: SeverityChoice,
  guildName: string,
  dmEnabled: boolean,
) {
  if (!dmEnabled) {
    return;
  }

  const messageLines = [
    `Du wurdest auf **${guildName}** verwarnt.`,
    `Moderator: ${moderatorTag}`,
    `Schweregrad: ${SEVERITY_MAP[severity] ?? severity}`,
    `Grund: ${reason}`,
  ];

  await member.user.send({ content: messageLines.join('\n') }).catch(() => {});
}

async function logEscalationCase(guildMember: GuildMember, escalationRecord: ModerationCaseRecord) {
  await logModerationCase(guildMember.guild, escalationRecord, {
    additionalFields: [
      {
        name: 'Automatische Maßnahme',
        value: 'Aus Eskalationslogik ausgelöst.',
      },
    ],
  });
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireModeratorPermission(interaction);

  const targetUser = interaction.options.getUser('spieler', true);
  const reasonRaw = interaction.options.getString('grund', true).trim();
  const severity = (interaction.options.getString('schweregrad') as SeverityChoice | null) ?? 'low';

  if (!reasonRaw) {
    await interaction.reply({
      content: '❌ Bitte gib einen gültigen Grund für die Verwarnung an.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: '❌ Du kannst dich nicht selbst verwarnen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;
  const config = await fetchModerationConfig(guild.id);
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  assertGuildMember(targetMember);

  const { caseRecord, escalation } = await createModerationCase({
    guildId: guild.id,
    type: 'warn',
    targetId: targetUser.id,
    targetTag: targetUser.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason: reasonRaw,
    severity,
    metadata: {
      command: 'warn',
    },
  });

  await logModerationCase(guild, caseRecord);

  await maybeNotifyUser(
    targetMember,
    interaction.user.tag,
    reasonRaw,
    severity,
    guild.name,
    config.notifications.dmOnAction,
  );

  const confirmation = `✅ <@${targetUser.id}> wurde verwarnt.`;
  await interaction.reply({
    content: confirmation,
    flags: MessageFlags.Ephemeral,
  });

  if (!escalation) {
    return;
  }

  await logEscalationCase(targetMember, escalation.caseRecord);

  const actionReason = `${escalation.action.reason} (ausgelöst durch ${interaction.user.tag})`;

  if (escalation.action.kind === 'timeout') {
    const durationMs = escalation.action.durationMs;
    try {
      await targetMember.timeout(durationMs, actionReason);

      const timeoutCase = await createModerationCase({
        guildId: guild.id,
        type: 'timeout',
        targetId: targetUser.id,
        targetTag: targetUser.tag,
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        reason: escalation.action.reason,
        durationMs,
        metadata: {
          escalationRuleId: escalation.rule.id,
          triggerCount: escalation.triggerCount,
          sourceCaseId: caseRecord.id,
        },
      });

      await logModerationCase(guild, timeoutCase.caseRecord, {
        additionalFields: [
          {
            name: 'Auslöser',
            value: `Automatische Eskalation nach ${escalation.triggerCount} Verwarnungen.`,
          },
        ],
      });
    } catch (error) {
      console.error('[warn] Failed to apply escalation timeout:', error);
      await sendModerationLog(
        guild,
        'moderation',
        {
          content: `⚠️ Automatische Eskalation konnte nicht ausgeführt werden. Bitte prüft die Berechtigungen für <@${targetUser.id}>.`,
        },
        { logTag: 'warn-escalation' },
      );
    }
  } else if (escalation.action.kind === 'ban') {
    try {
      await targetMember.ban({ reason: actionReason, deleteMessageSeconds: 0 });

      const banCase = await createModerationCase({
        guildId: guild.id,
        type: 'ban',
        targetId: targetUser.id,
        targetTag: targetUser.tag,
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        reason: escalation.action.reason,
        metadata: {
          escalationRuleId: escalation.rule.id,
          triggerCount: escalation.triggerCount,
          sourceCaseId: caseRecord.id,
        },
      });

      await logModerationCase(guild, banCase.caseRecord, {
        additionalFields: [
          {
            name: 'Auslöser',
            value: `Automatische Eskalation nach ${escalation.triggerCount} Verwarnungen.`,
          },
        ],
      });
    } catch (error) {
      console.error('[warn] Failed to apply escalation ban:', error);
      await sendModerationLog(
        guild,
        'moderation',
        {
          content: `⚠️ Automatische Bann-Eskalation für <@${targetUser.id}> fehlgeschlagen. Bitte prüft die Berechtigungen.`,
        },
        { logTag: 'warn-escalation' },
      );
    }
  } else if (escalation.action.kind === 'kick') {
    try {
      await targetMember.kick(actionReason);

      const kickCase = await createModerationCase({
        guildId: guild.id,
        type: 'kick',
        targetId: targetUser.id,
        targetTag: targetUser.tag,
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        reason: escalation.action.reason,
        metadata: {
          escalationRuleId: escalation.rule.id,
          triggerCount: escalation.triggerCount,
          sourceCaseId: caseRecord.id,
        },
      });

      await logModerationCase(guild, kickCase.caseRecord, {
        additionalFields: [
          {
            name: 'Auslöser',
            value: `Automatische Eskalation nach ${escalation.triggerCount} Verwarnungen.`,
          },
        ],
      });
    } catch (error) {
      console.error('[warn] Failed to apply escalation kick:', error);
      await sendModerationLog(
        guild,
        'moderation',
        {
          content: `⚠️ Automatische Kick-Eskalation für <@${targetUser.id}> fehlgeschlagen. Bitte prüft die Berechtigungen.`,
        },
        { logTag: 'warn-escalation' },
      );
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
