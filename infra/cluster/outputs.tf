output "cluster_name" {
  value = module.eks.cluster_name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "rds_host" {
  value = aws_db_instance.main.address
}

output "rds_master_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "data_jobs_role_arn" {
  value = aws_iam_role.data_jobs.arn
}

output "api_role_arn" {
  value = aws_iam_role.api.arn
}

output "apps_namespace" {
  value = var.apps_namespace
}

output "vpc_id" {
  value = module.vpc.vpc_id
}
