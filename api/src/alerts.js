import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'

// Email the team when an operation fails (SNS topic rebound-alerts from infra/foundation/alerts.tf).
// Without ALERTS_TOPIC_ARN (local dev) alerts are off. Sending is best effort: a failed alert never
// changes the operation's outcome. Crashes that never reach this code (the worker dies 3 times and SQS
// moves the message to the dead-letter queue) are caught by the CloudWatch alarm on that queue instead.
const VERBS = { deploy: 'Deploy', redeploy: 'Rollback', backup: 'Backup', restore: 'Restore', delete: 'Delete' }

export function alertText(op, publicUrl) {
  const failed = op.steps?.find((s) => s.state === 'failed')
  const what = `${VERBS[op.kind] ?? op.kind} of ${op.appId}`
  return {
    subject: `[Rebound] ${what} failed`.slice(0, 99),
    message: [
      `${what} failed${failed ? ` at the "${failed.label}" step` : ''}.`,
      '',
      `Error: ${op.error ?? 'unknown'}`,
      `Started by: ${op.startedBy ?? 'the platform'}`,
      `Started at: ${op.startedAt}`,
      `Operation: ${op.id}`,
      ...(publicUrl ? ['', `Dashboard: ${publicUrl.replace(/\/$/, '')}/activity`] : []),
    ].join('\n'),
  }
}

export function createAlerts(config, client) {
  if (!config.alertsTopicArn) return undefined
  const sns = client ?? new SNSClient({ region: config.s3.region })
  return {
    async operationFailed(op) {
      const { subject, message } = alertText(op, config.publicUrl)
      await sns.send(new PublishCommand({ TopicArn: config.alertsTopicArn, Subject: subject, Message: message }))
    },
  }
}
