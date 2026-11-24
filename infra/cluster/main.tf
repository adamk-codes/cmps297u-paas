# Per-session infrastructure: everything billed by the hour. `terraform destroy` after every session
# (infra/scripts/down.sh). Long-lived pieces (KMS, backups, ECR, Cognito, CloudFront) are in ../foundation
# and looked up by name below.

data "aws_caller_identity" "current" {}
data "aws_iam_session_context" "current" {
  arn = data.aws_caller_identity.current.arn
}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name       = var.name
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)

  # Whoever applies (their role, not the temporary session) is always an admin.
  admin_arns = distinct(concat(var.admin_principal_arns, [data.aws_iam_session_context.current.issuer_arn]))
}

# ---------------------------------------------------------------- foundation lookups

data "aws_kms_alias" "main" {
  name = "alias/${var.name}"
}

data "aws_s3_bucket" "backups" {
  bucket = "${var.name}-backups-${local.account_id}"
}

data "aws_iam_role" "ci" {
  name = "${var.name}-github-ci"
}

# ---------------------------------------------------------------- network

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets  = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]   # /20 each, pods + nodes
  public_subnets   = [cidrsubnet(var.vpc_cidr, 8, 48), cidrsubnet(var.vpc_cidr, 8, 49)] # ALB
  database_subnets = [cidrsubnet(var.vpc_cidr, 8, 64), cidrsubnet(var.vpc_cidr, 8, 65)] # RDS, no internet route

  # One NAT gateway (not one per AZ): saves ~$32/month; an AZ outage would cut egress, acceptable here.
  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true

  create_database_subnet_group = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ---------------------------------------------------------------- EKS

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name                   = local.name
  kubernetes_version     = var.kubernetes_version
  upgrade_policy         = { support_type = "STANDARD" }
  endpoint_public_access = true # kubectl from laptops and GitHub Actions; auth is still IAM
  enable_irsa            = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Encrypt Kubernetes Secrets (DB URLs) with our KMS key.
  encryption_config = {
    provider_key_arn = data.aws_kms_alias.main.target_key_arn
    resources        = ["secrets"]
  }
  create_kms_key = false

  addons = {
    coredns                = {}
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = [var.node_instance_type]
      min_size       = var.node_count
      desired_size   = var.node_count
      max_size       = var.node_count + 1
    }
  }

  enable_cluster_creator_admin_permissions = false
  access_entries = merge(
    {
      for i, arn in local.admin_arns : "admin-${i}" => {
        principal_arn = arn
        policy_associations = {
          admin = {
            policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
            access_scope = { type = "cluster" }
          }
        }
      }
    },
    {
      # GitHub Actions deploys apps, but only inside the apps namespace.
      ci = {
        principal_arn = data.aws_iam_role.ci.arn
        policy_associations = {
          edit = {
            policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"
            access_scope = { type = "namespace", namespaces = [var.apps_namespace] }
          }
        }
      }
    },
  )
}
