# IAM roles for our own workloads (IRSA): each Kubernetes service account gets exactly what it needs.
# Mirrors jobs/backup-restore/k8s/iam-policy.json and api/k8s/iam-policy.json.

locals {
  kms_arn    = data.aws_kms_alias.main.target_key_arn
  bucket_arn = data.aws_s3_bucket.backups.arn
}

data "aws_iam_policy_document" "irsa_trust" {
  for_each = {
    data_jobs = "rebound-data-jobs"
    api       = "rebound-api"
  }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:${var.apps_namespace}:${each.value}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

# Backup/restore/provision Jobs.
resource "aws_iam_role" "data_jobs" {
  name               = "${local.name}-data-jobs"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["data_jobs"].json
}

data "aws_iam_policy_document" "data_jobs" {
  statement {
    sid       = "BackupObjects"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${local.bucket_arn}/backups/*"]
  }
  statement {
    sid       = "ListBackups"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["backups/*"]
    }
  }
  statement {
    sid       = "Encryption"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt", "kms:DescribeKey"]
    resources = [local.kms_arn]
  }
  statement {
    sid = "AppDatabaseSecrets"
    actions = [
      "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue",
      "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:TagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.name}/apps/*"]
  }
}

resource "aws_iam_role_policy" "data_jobs" {
  name   = "data-jobs"
  role   = aws_iam_role.data_jobs.id
  policy = data.aws_iam_policy_document.data_jobs.json
}

# Platform API: lists backups and reads their metadata; everything else goes through Jobs.
resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["api"].json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "ListBackups"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["backups/*"]
    }
  }
  statement {
    sid       = "ReadBackupMetadata"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/backups/*"]
  }
  statement {
    sid       = "CostsPage" # Cost Explorer has no resource-level permissions
    actions   = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
    resources = ["*"]
  }
  statement {
    sid       = "BudgetField"
    actions   = ["budgets:ViewBudget", "budgets:ModifyBudget"]
    resources = ["arn:aws:budgets::${local.account_id}:budget/${var.name}-monthly"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
