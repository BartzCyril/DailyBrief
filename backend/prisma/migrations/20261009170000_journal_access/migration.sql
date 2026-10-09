CREATE TABLE "JournalAccess" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "email" TEXT,
  "encryptedPassword" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JournalAccess_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "JournalAccess_userId_domain_key" ON "JournalAccess"("userId", "domain");
