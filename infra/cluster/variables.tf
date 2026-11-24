variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Name prefix; must match the foundation stack."
  type        = string
  default     = "rebound"
}

variable "kubernetes_version" {
  type    = string
  default = "1.35"
}

variable "node_instance_type" {
  type    = string
  default = "c7i-flex.large"
}

variable "node_count" {
  description = "Worker nodes (min = desired). Max is one more, for headroom during the load test."
  type        = number
  default     = 2
}

variable "postgres_version" {
  description = "RDS PostgreSQL major version. The jobs image's client (PG_MAJOR) must be >= this."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "admin_principal_arns" {
  description = <<-EOT
    IAM users/roles of team members who get cluster-admin through EKS access entries
    (e.g. arn:aws:iam::123456789012:user/ahmad). Whoever runs terraform is added automatically.
  EOT
  type        = list(string)
  default     = []
}

variable "apps_namespace" {
  type    = string
  default = "apps"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
