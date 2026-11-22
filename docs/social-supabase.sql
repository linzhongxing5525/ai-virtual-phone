-- Starforest 双站真人社交迁移
-- 只新增独立表，不删除、不清空、不改写现有角色、聊天或记忆数据。

create extension if not exists pgcrypto;

create table if not exists public.social_friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user_id text not null references public.app_users(id) on delete cascade,
  to_user_id text not null references public.app_users(id) on delete cascade,
  message text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);

create unique index if not exists social_friend_requests_one_pending
  on public.social_friend_requests(from_user_id, to_user_id)
  where status = 'pending';
create index if not exists social_friend_requests_to_idx
  on public.social_friend_requests(to_user_id, status, created_at desc);

create table if not exists public.social_friendships (
  id uuid primary key default gen_random_uuid(),
  user_a text not null references public.app_users(id) on delete cascade,
  user_b text not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((user_a collate "C") < (user_b collate "C")),
  unique(user_a, user_b)
);
-- Older copies of this migration used the database's default collation. Make
-- the ordering deterministic and identical to the server's ASCII comparison.
alter table public.social_friendships
  drop constraint if exists social_friendships_check;
alter table public.social_friendships
  add constraint social_friendships_check
  check ((user_a collate "C") < (user_b collate "C"));
create index if not exists social_friendships_a_idx on public.social_friendships(user_a);
create index if not exists social_friendships_b_idx on public.social_friendships(user_b);

create table if not exists public.social_messages (
  id uuid primary key default gen_random_uuid(),
  friendship_id uuid not null references public.social_friendships(id) on delete cascade,
  sender_id text not null references public.app_users(id) on delete cascade,
  body text not null,
  message_type text not null default 'text' check (message_type in ('text', 'system')),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists social_messages_thread_idx
  on public.social_messages(friendship_id, created_at desc);

create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  author_id text not null references public.app_users(id) on delete cascade,
  body text not null,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists social_posts_feed_idx on public.social_posts(created_at desc) where deleted_at is null;

create table if not exists public.social_post_likes (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, user_id)
);

create table if not exists public.social_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  author_id text not null references public.app_users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists social_post_comments_post_idx
  on public.social_post_comments(post_id, created_at asc);

create table if not exists public.social_listening_sessions (
  friendship_id uuid primary key references public.social_friendships(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_by text not null references public.app_users(id) on delete cascade,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.social_friend_requests enable row level security;
alter table public.social_friendships enable row level security;
alter table public.social_messages enable row level security;
alter table public.social_posts enable row level security;
alter table public.social_post_likes enable row level security;
alter table public.social_post_comments enable row level security;
alter table public.social_listening_sessions enable row level security;

-- 浏览器不直接读写表；Next.js 服务端在验证登录 cookie 后用 service role 访问。
-- 因此不为 anon/authenticated 创建表策略，避免任意客户端绕过好友权限。

comment on table public.social_friendships is '真人账号好友关系，与本地 AI 角色好友完全分离';
comment on table public.social_messages is '真人私聊消息';
comment on table public.social_posts is '真人账号朋友圈';
comment on table public.social_listening_sessions is '两位真人好友的一起听同步状态';
