output "instance_id" {
  value = aws_instance.devlab.id
}

output "private_ip" {
  value = aws_instance.devlab.private_ip
}

output "public_ip" {
  value = aws_instance.devlab.public_ip
}

output "devlab_ui_url" {
  value = "http://${coalesce(aws_instance.devlab.public_ip, aws_instance.devlab.private_ip)}:4321"
}

output "ollama_endpoint" {
  description = "Point dev machines at this: OPENAI_COMPAT_BASE_URL"
  value       = "http://${aws_instance.devlab.private_ip}:11434"
}

output "ssh_command" {
  value = "ssh -i <key.pem> ubuntu@${coalesce(aws_instance.devlab.public_ip, aws_instance.devlab.private_ip)}"
}
