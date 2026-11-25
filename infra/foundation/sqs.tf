resource "aws_sqs_queue" "operations_dlq" {
  name                      = "${var.name}-operations-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "operations" {
  name                       = "${var.name}-operations"
  visibility_timeout_seconds = 1800
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.operations_dlq.arn
    maxReceiveCount     = 3
  })
}

output "operations_queue_url" {
  value = aws_sqs_queue.operations.url
}

output "operations_queue_arn" {
  value = aws_sqs_queue.operations.arn
}

output "operations_dlq_url" {
  value = aws_sqs_queue.operations_dlq.url
}
