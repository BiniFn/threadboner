create table if not exists private_pdf_releases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  volume_number integer not null,
  pathname text not null unique,
  premiere_at timestamptz not null,
  uploaded_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists private_pdf_releases_premiere_idx
  on private_pdf_releases (premiere_at, volume_number desc)
  where uploaded_at is not null;
