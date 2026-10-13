#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" || "$#" != 1 ]]; then
  printf '%s\n' 'Usage: sudo bash deploy/tempo-vps/install-dependencies.sh --apply' >&2
  exit 64
fi
[[ "$EUID" == 0 ]] || { printf '%s\n' 'Run as root.' >&2; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { printf '%s\n' 'Requires Ubuntu 24.04.' >&2; exit 1; }

readonly project_root=/Users/jungle/Desktop/dev/agentfuel-tempo
readonly node_version=22.23.2
readonly go_version=1.26.3
case "$(dpkg --print-architecture)" in
  amd64)
    node_arch=x64; go_arch=amd64
    node_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
    go_sha=2b2cfc7148493da5e73981bffbf3353af381d5f93e789c82c79aff64962eb556
    ;;
  arm64)
    node_arch=arm64; go_arch=arm64
    node_sha=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
    go_sha=9d89a3ea57d141c2b22d70083f2c8459ba3890f2d9e818e7e933b75614936565
    ;;
  *) printf '%s\n' 'Only amd64/arm64 are supported.' >&2; exit 1 ;;
esac

# Do not uninstall another container engine or its runtime automatically.
for package in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" == installed ]]; then
    printf 'Conflicting Docker package: %s. Review it before proceeding.\n' "$package" >&2
    exit 1
  fi
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg xz-utils tar git build-essential patch jq python3 \
  nginx certbot python3-certbot-nginx bubblewrap socat util-linux apparmor-utils apparmor-profiles

staging=$(mktemp -d /tmp/tabby-tempo-install.XXXXXXXX)
trap 'rm -r -- "$staging"' EXIT
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
go_archive="go${go_version}.linux-${go_arch}.tar.gz"
download() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 240 --retry 3 "$1" --output "$2"
}
# SHA256 values verified against the official sources on 2026-10-13.
# https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
# https://go.dev/dl/?mode=json&include=all
download "https://nodejs.org/dist/v${node_version}/${node_archive}" "$staging/$node_archive"
download "https://go.dev/dl/${go_archive}" "$staging/$go_archive"
printf '%s  %s\n' "$node_sha" "$staging/$node_archive" | sha256sum --check --status
printf '%s  %s\n' "$go_sha" "$staging/$go_archive" | sha256sum --check --status
install -d -m 0755 /opt/tabby-tempo
node_target="/opt/tabby-tempo/node-v${node_version}-linux-${node_arch}"
go_target="/opt/tabby-tempo/go${go_version}-linux-${go_arch}"
if [[ ! -e "$node_target" ]]; then
  install -d -m 0755 "$node_target"
  tar -xJf "$staging/$node_archive" -C "$node_target" --strip-components=1
fi
if [[ ! -e "$go_target" ]]; then
  install -d -m 0755 "$go_target"
  tar -xzf "$staging/$go_archive" -C "$go_target" --strip-components=1
fi
[[ "$("$node_target/bin/node" --version)" == "v$node_version" ]]
[[ "$("$go_target/bin/go" version)" == "go version go${go_version} linux/${go_arch}" ]]
for alias in /opt/tabby-tempo/node /opt/tabby-tempo/go; do
  [[ ! -e "$alias" || -L "$alias" ]] || { printf 'Conflicting toolchain directory: %s\n' "$alias" >&2; exit 1; }
done
ln -sfn "$node_target" /opt/tabby-tempo/node
ln -sfn "$go_target" /opt/tabby-tempo/go

# Official signed Docker APT repository; no downloaded install shell.
install -d -m 0755 /etc/apt/keyrings
download https://download.docker.com/linux/ubuntu/gpg "$staging/docker.asc"
install -m 0644 "$staging/docker.asc" /etc/apt/keyrings/tabby-tempo-docker.asc
cat >/etc/apt/sources.list.d/tabby-tempo-docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/tabby-tempo-docker.asc
EOF
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

getent group tabby-tempo >/dev/null || groupadd --system tabby-tempo
if ! id tabby-tempo >/dev/null 2>&1; then
  useradd --system --gid tabby-tempo --home-dir /var/lib/tabby-tempo --create-home --shell /usr/sbin/nologin tabby-tempo
fi
[[ "$(id -gn tabby-tempo)" == tabby-tempo ]] || { printf '%s\n' 'Existing tabby-tempo user has an unexpected primary group.' >&2; exit 1; }
install -d -m 0755 -o tabby-tempo -g tabby-tempo "$project_root"
[[ "$(realpath "$project_root")" == "$project_root" ]] || { printf '%s\n' 'Project must be a physical path, not a symlink.' >&2; exit 1; }
if [[ -e /srv/tabby-tempo || -L /srv/tabby-tempo ]]; then
  [[ -L /srv/tabby-tempo && "$(readlink /srv/tabby-tempo)" == "$project_root" ]] || { printf '%s\n' '/srv/tabby-tempo conflicts with the required symlink.' >&2; exit 1; }
else
  ln -s "$project_root" /srv/tabby-tempo
fi
install -d -m 0750 -o root -g tabby-tempo /etc/tabby-tempo
install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
printf '%s\n' 'Dependencies installed. No project state was initialized and no application unit was started.'
printf '%s\n' 'Ubuntu package hooks may start Docker/nginx. Review their status before activating the supplied site.'
