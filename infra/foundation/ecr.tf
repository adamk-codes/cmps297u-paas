# Image registry. Tags are immutable (a tag always means the same image, so a backup's image tag can be
# redeployed exactly), images are scanned on push, and old untagged images are cleaned up.

locals {
  ecr_repositories = toset(concat(var.app_names, ["rebound-api", "rebound/backup-restore"]))
}

resource "aws_ecr_repository" "repo" {
  for_each             = local.ecr_repositories
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Drop untagged images after 3 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 3 }
        action       = { type = "expire" }
      },
      {
        # Keep enough history that every backup's image (30 days of backups) can still be redeployed.
        rulePriority = 2
        description  = "Keep the newest 30 tagged images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      },
    ]
  })
}
