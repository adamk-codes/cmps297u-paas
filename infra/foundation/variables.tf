variable "region" {
  description = "AWS region for everything."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "rebound"
}

variable "app_names" {
  description = "Sample apps that get an ECR repository (images are <registry>/<app>:<tag>)."
  type        = list(string)
  default     = ["notes-app", "shop-api"]
}

variable "team_emails" {
  description = "Team members to create in the Cognito user pool. Cognito emails each a temporary password."
  type        = list(string)
  default     = []
}

variable "budget_limit_usd" {
  description = "Monthly AWS budget; alerts at 50%, 80% and 100% (forecast)."
  type        = number
  default     = 40
}

variable "budget_alert_emails" {
  description = "Who gets budget alerts."
  type        = list(string)
  default     = []
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI role through GitHub OIDC (pushes to ECR, deploys to EKS)."
  type        = string
  default     = "adamk-codes/cmps297u-paas"
}

variable "create_github_oidc_provider" {
  description = "Set false if the account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}

variable "alb_dns_name" {
  description = <<-EOT
    DNS name of the shared ALB created by the cluster stack's Ingresses (changes every session).
    When set, CloudFront also serves /api/* and /apps/* from it over HTTPS. infra/scripts/up.sh sets it.
  EOT
  type        = string
  default     = ""
}

variable "backup_retention_days" {
  description = "Delete backup objects after this many days."
  type        = number
  default     = 30
}

variable "enable_cloudtrail" {
  description = "Create a CloudTrail trail for management events (first trail's management events are free)."
  type        = bool
  default     = true
}
