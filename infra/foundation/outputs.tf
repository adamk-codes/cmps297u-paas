output "region" {
  value = var.region
}

output "account_id" {
  value = local.account_id
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "tfstate_bucket" {
  value = aws_s3_bucket.tfstate.id
}

output "ecr_registry" {
  value = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.team.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.dashboard.id
}

output "dashboard_bucket" {
  value = aws_s3_bucket.dashboard.id
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "public_url" {
  description = "Dashboard, API (/api) and apps (/apps/<name>) over HTTPS."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ci_role_arn" {
  description = "Role for GitHub Actions (aws-actions/configure-aws-credentials role-to-assume)."
  value       = aws_iam_role.ci.arn
}
