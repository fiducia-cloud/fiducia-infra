# EKS cluster for a fiducia failure domain (AWS).
# e2e/test-grade baseline: by default uses the account's DEFAULT VPC subnets and a
# public API endpoint open to 0.0.0.0/0 to stay small and CI-friendly.
#
# Prod-hardening is OPT-IN via variables that all DEFAULT to this e2e behavior
# (see variables.tf): set var.subnet_ids to run in a dedicated/private VPC, and
# var.authorized_api_cidrs / var.endpoint_private_access to restrict API access.
# Existing e2e applies that pass none of these are unchanged.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# --- IAM: cluster role ------------------------------------------------------
data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.cluster_name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.labels
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# --- IAM: node role ---------------------------------------------------------
data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.cluster_name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.labels
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# --- cluster + node group ---------------------------------------------------
locals {
  # Dedicated-VPC opt-in: use operator-supplied subnets when provided, else the
  # default VPC's (e2e behavior).
  subnet_ids = length(var.subnet_ids) > 0 ? var.subnet_ids : data.aws_subnets.default.ids
  # Authorized-ranges opt-in: an empty list keeps the endpoint open to the world
  # (EKS default), matching current e2e behavior.
  public_access_cidrs = length(var.authorized_api_cidrs) > 0 ? var.authorized_api_cidrs : ["0.0.0.0/0"]
}

resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.k8s_version
  tags     = var.labels

  vpc_config {
    subnet_ids = local.subnet_ids
    # Defaults below reproduce the e2e-grade public endpoint open to 0.0.0.0/0.
    # Tighten for prod by opting into private access and/or authorized CIDRs.
    endpoint_public_access  = var.endpoint_public_access
    endpoint_private_access = var.endpoint_private_access
    public_access_cidrs     = local.public_access_cidrs
  }

  depends_on = [aws_iam_role_policy_attachment.cluster_policy]
}

resource "aws_eks_node_group" "primary" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.cluster_name}-ng"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = data.aws_subnets.default.ids
  instance_types  = [var.instance_type]
  labels          = var.labels

  scaling_config {
    desired_size = var.node_count
    min_size     = var.node_count
    max_size     = var.node_count
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}
