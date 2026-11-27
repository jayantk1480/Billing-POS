-- Sign-up for new restaurants, their subscription state, and the platform (vendor) admin.

-- Subscription. A restaurant with neither date has no time limit, which is what every existing one gets.
ALTER TABLE "restaurants"
  ADD COLUMN "trial_ends_at" TIMESTAMP(3),
  ADD COLUMN "paid_until" DATE,
  ADD COLUMN "suspended_at" TIMESTAMP(3),
  ADD COLUMN "suspend_reason" TEXT,
  ADD COLUMN "created_via" VARCHAR(10) NOT NULL DEFAULT 'SEED',
  ADD COLUMN "onboarding_dismissed_at" TIMESTAMP(3);
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_created_via_known" CHECK (created_via IN ('SEED', 'SIGNUP', 'PLATFORM'));
-- A suspended restaurant always says when and why.
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_suspension_recorded" CHECK (is_active OR suspended_at IS NOT NULL);
-- Restaurants that exist already were set up by hand and need no getting-started list.
UPDATE "restaurants" SET "onboarding_dismissed_at" = now();
UPDATE "restaurants" SET "suspended_at" = now(), "suspend_reason" = 'Switched off before suspension reasons were recorded' WHERE NOT "is_active";

-- Everyone who has an account today was given it by their restaurant's owner; only sign-ups have to prove their address.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "users" SET "email_verified_at" = "created_at";

CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The vendor's own people. They are not restaurant users and have no restaurant.
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");
CREATE INDEX "platform_sessions_admin_id_idx" ON "platform_sessions"("admin_id");
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
