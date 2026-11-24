terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Local state by default. After the first apply, move it into the state bucket this stack creates:
  #   terraform init -migrate-state -backend-config=../backend.hcl -backend-config="key=foundation.tfstate"
  # (uncomment the block below first). See infra/README.md.
  # backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "rebound"
      Course    = "CMPS297U"
      Stack     = "foundation"
      ManagedBy = "terraform"
    }
  }
}

# CloudFront and its certificates live in us-east-1; we deploy there anyway.
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
