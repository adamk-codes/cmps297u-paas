# One shared PostgreSQL instance: one database + login per app (created by the provision job), plus the
# platform database. Single-AZ to save cost; recovery is from our pg_dump backups in S3, which outlive it.

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "PostgreSQL from EKS nodes and pods only"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_nodes" {
  for_each = {
    nodes   = module.eks.node_security_group_id
    cluster = module.eks.cluster_primary_security_group_id
  }
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from EKS (${each.key})"
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-postgres"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = data.aws_kms_alias.main.target_key_arn

  # Master password generated and rotated by RDS, stored in Secrets Manager, never in Terraform state.
  username                      = "rebound_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = data.aws_kms_alias.main.target_key_arn

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  # Session infrastructure: no final snapshot, no deletion protection, no automated backups
  # (our verified pg_dump backups in S3 are the recovery path).
  backup_retention_period    = 0
  skip_final_snapshot        = true
  deletion_protection        = false
  apply_immediately          = true
  auto_minor_version_upgrade = true

  performance_insights_enabled    = false
  enabled_cloudwatch_logs_exports = ["postgresql"]
}
