# Email alerts. Everything here is in the AWS free tier (10 CloudWatch alarms, 1,000 SNS emails a month).
#  - The platform API publishes to this topic when a deploy, backup, restore or delete fails (api/src/alerts.js).
#  - CloudWatch alarms cover what the API can't report itself: a message that crashed the worker 3 times
#    (moved to the dead-letter queue), and work stuck in the queue because no worker is picking it up.
# Each address gets a "Subscription Confirmation" email from AWS and must click the link once.

locals {
  alert_emails = length(var.alert_emails) > 0 ? var.alert_emails : var.budget_alert_emails
}

# Not KMS-encrypted on purpose: CloudWatch alarms can't publish to a topic using the AWS-managed SNS key,
# and the messages hold no secrets (app name, step, error text).
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  for_each  = toset(local.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.key
}

resource "aws_cloudwatch_metric_alarm" "operations_dlq" {
  alarm_name          = "${var.name}-operations-dead-letters"
  alarm_description   = "A backup, restore or deploy crashed the worker 3 times and was moved to ${aws_sqs_queue.operations_dlq.name}. Check: kubectl -n apps logs deploy/rebound-worker"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.operations_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "operations_stuck" {
  alarm_name          = "${var.name}-operations-stuck"
  alarm_description   = "Work has waited over 15 minutes in ${aws_sqs_queue.operations.name}: the rebound-worker is down or overloaded. Check: kubectl -n apps get pods"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.operations.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
