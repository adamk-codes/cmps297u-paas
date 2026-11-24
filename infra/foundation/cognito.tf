# Team sign-in. Admin-created users only (no public sign-up); Cognito emails each a temporary password,
# and the dashboard asks for a new one on first sign-in.

resource "aws_cognito_user_pool" "team" {
  name                     = "${var.name}-team"
  deletion_protection      = "INACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your Rebound sign-in"
      email_message = "Welcome to Rebound. Sign in with {username} and this temporary password: {####}"
      sms_message   = "Rebound: {username} / {####}"
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# Public SPA client: no secret. USER_PASSWORD_AUTH lets the dashboard sign in with one HTTPS call
# (always over TLS to Cognito); SRP is allowed too for an Amplify-based client.
resource "aws_cognito_user_pool_client" "dashboard" {
  name                          = "${var.name}-dashboard"
  user_pool_id                  = aws_cognito_user_pool.team.id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 7
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user" "team" {
  for_each     = toset(var.team_emails)
  user_pool_id = aws_cognito_user_pool.team.id
  username     = each.key
  attributes = {
    email          = each.key
    email_verified = true
  }
  desired_delivery_mediums = ["EMAIL"]
}
