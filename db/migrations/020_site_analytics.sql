create table if not exists site_analytics (
  id bigserial primary key,
  visitor_id uuid not null,
  event_type text not null check (event_type in ('page_view', 'reader_view', 'volume_open')),
  page_path text not null,
  volume_id text,
  created_at timestamptz not null default now()
);

create index if not exists site_analytics_created_at_idx
  on site_analytics (created_at desc);

create index if not exists site_analytics_visitor_created_idx
  on site_analytics (visitor_id, created_at desc);

create index if not exists site_analytics_type_created_idx
  on site_analytics (event_type, created_at desc);
