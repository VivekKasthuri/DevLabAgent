# DevLab — private-VPC deployment (Option C)
# One GPU instance running Ollama + DevLab via Docker Compose (cloud-init).

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ── Network ──────────────────────────────────────────────────────────────────
resource "aws_vpc" "devlab" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = { Name = "devlab-vpc" }
}

resource "aws_subnet" "devlab" {
  vpc_id                  = aws_vpc.devlab.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = "${var.region}a"
  map_public_ip_on_launch = var.assign_public_ip
  tags                    = { Name = "devlab-subnet" }
}

resource "aws_internet_gateway" "devlab" {
  vpc_id = aws_vpc.devlab.id
  tags   = { Name = "devlab-igw" }
}

resource "aws_route_table" "devlab" {
  vpc_id = aws_vpc.devlab.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.devlab.id
  }
  tags = { Name = "devlab-rt" }
}

resource "aws_route_table_association" "devlab" {
  subnet_id      = aws_subnet.devlab.id
  route_table_id = aws_route_table.devlab.id
}

resource "aws_security_group" "devlab" {
  name        = "devlab-sg"
  description = "DevLab UI + Ollama, restricted to allowed_cidr"
  vpc_id      = aws_vpc.devlab.id

  ingress {
    description = "DevLab web UI"
    from_port   = 4321
    to_port     = 4321
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "Ollama API (for devs pointing local CLIs at the VPC LLM)"
    from_port   = 11434
    to_port     = 11434
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "devlab-sg" }
}

# ── GPU instance ─────────────────────────────────────────────────────────────
# Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) — drivers + Docker preinstalled
data "aws_ami" "dl_base" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_instance" "devlab" {
  ami                    = data.aws_ami.dl_base.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.devlab.id
  vpc_security_group_ids = [aws_security_group.devlab.id]

  root_block_device {
    volume_size = var.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    devlab_repo    = var.devlab_repo
    devlab_model   = var.devlab_model
    devlab_api_key = var.devlab_api_key
  })

  tags = { Name = "devlab-server" }
}
