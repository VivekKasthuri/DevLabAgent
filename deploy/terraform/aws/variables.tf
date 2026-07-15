variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR for the DevLab VPC"
  type        = string
  default     = "10.42.0.0/16"
}

variable "allowed_cidr" {
  description = "CIDR allowed to reach the UI/Ollama/SSH (e.g. corporate VPN range). Never 0.0.0.0/0 in production."
  type        = string
}

variable "assign_public_ip" {
  description = "Assign a public IP (false for VPN/DirectConnect-only access)"
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "GPU instance type. g5.12xlarge (4x A10G, 96GB VRAM) fits gpt-oss:120b 4-bit; g5.2xlarge (1x A10G) for gpt-oss:20b."
  type        = string
  default     = "g5.12xlarge"
}

variable "disk_gb" {
  description = "Root EBS volume size (model weights need ~100GB for 120b)"
  type        = number
  default     = 300
}

variable "key_name" {
  description = "EC2 key pair name for SSH"
  type        = string
}

variable "devlab_repo" {
  description = "Git URL of the DevLab repository to deploy"
  type        = string
  default     = ""
}

variable "devlab_model" {
  description = "Ollama model tag to pull on boot"
  type        = string
  default     = "gpt-oss:120b"
}

variable "devlab_api_key" {
  description = "Bearer token required by the DevLab web UI/API. Leave empty to auto-generate on the instance."
  type        = string
  default     = ""
  sensitive   = true
}
