/**
 * The reader behind the PreToolUse hook (adapters/claude-code/push-spellings.mjs): an accept and a reject corpus,
 * written by hand in the shapes real sessions use, the record of what Claude Code's ask rule does with each spelling,
 * and a real shell's and a real git's answer to which commands reach a push: a bare remote that logs what it receives,
 * and a stand-in `git` first on PATH that writes its arguments and runs the real one. A refusal stalls an agent and a
 * miss is a push nobody was asked about, so both directions are held. Then the hook itself, as Claude Code runs it, on
 * temporary projects; test/reference/pretooluse.json records what Claude Code does with what it prints.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mayHold } from "../adapters/claude-code/config-place.mjs";
import { pushAliases, pushSpelling } from "../adapters/claude-code/push-spellings.mjs";
import { SPELLINGS, readRecord } from "./reference/claude-code.mjs";

/**
 * Pushes left alone, which only the rule stops: a shell reaches each, and Claude Code's parser finishes on each, so the rule
 * asks (test/reference/pretooluse.json and, for the rest of the shapes, the lab in the impact table).
 */
const ASKED = [
  "git push",
  "git push origin main",
  "git push --force-with-lease origin HEAD",
  "git push -u origin feat/x",
  "git push --force-with-lease=main:e96a9fa origin HEAD:main",
  "git push --help",
  // A pipe or a redirect after it.
  "git push 2>&1 | tail -3",
  "git push origin main > /dev/null",
  "git push > out 2>&1",
  "git push origin main; echo done",
  "git push || true",
  "git push && echo ok || echo no",
  "git push -q origin main 2>&1 | grep -v x | tail -1 && echo ok",
  // Another folder, in one call: the prompt shows the folder.
  "cd sub && git push",
  "cd sub && git push origin main 2>&1 | tail -3",
  // A command of the top-level list, whatever stands before it in the list, in plain words.
  "git add . && git push",
  "git add -A && git commit --allow-empty -qm x && git push",
  "git add . && git commit --allow-empty -qm x && git push origin main 2>&1 | tail -3",
  "true; git push",
  "false || git push",
  "true\ngit push\n",
  " git push",
  "echo x | git push",
  "git push; git push origin main",
  "git fetch origin\ngit push > out 2>&1",
  "echo a > b\ngit push origin main",
  "if true; then echo a; fi\ngit push",
  "for f in a b; do echo a; done; git push",
];

/** Commands that reach no push, each in a shape a session writes: left alone. */
const LEFT = [
  // Text that says "git push" and pushes nothing.
  "echo git push",
  "echo 'git -C . push'",
  "printf 'git push\\n'",
  "printf '%s\\n' git -C . push",
  'git commit -m "docs: git -C dir push is refused"',
  "git commit -qm 'say git push' && git log -1",
  'git commit -F - <<\'EOF\'\nfix: the hook reads git -C . push\n\nsh -c \'git push\' too\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nsay sh -c "git push" and don\'t\nEOF\n)"',
  'git log --grep="git push" --oneline',
  'git log --grep "git -C . push"',
  'grep -rn "git push" docs/',
  "grep -rn 'git -C' docs | grep push",
  "rg -n 'git -C \\S+ push' adapters/",
  "man git push",
  "sed -n 's/git push/x/p' README.md",
  "awk '/git push/ { print }' README.md",
  'node -e \'console.log("git -C . push")\'',
  "node scripts/ennyn.mjs mutate list.json --command 'node --test test/push-spellings.test.mjs'",
  "cat > notes.md <<'EOF'\ngit -C . push\nsh -c 'git push'\nEOF",
  "cat <<'EOF'\n$(git -C . push)\nEOF",
  "cat <<EOF\ngit -C . push\nEOF",
  "cat <<EOF | grep -c push\ngit -C . push\nEOF",
  "cat <<EOF\ncost \\$(git -C . push) and \\`git -C . push\\`\nEOF",
  "tee x <<< 'git -C . push'",
  "cat <<EOF\n$(date)\nEOF\necho git push",
  "cat > notes.md <<'EOF'\non: push\nEOF\n$R/run.sh",
  "echo $'it\\'s git -C . push'",
  "echo x &> /dev/null git -C . push",
  "sort -S 1M notes.md && echo push",
  // env's and find's flags are theirs: on another program's words they are no splitter.
  "sort -S 1M push",
  "curl -sS -H 'x: push' 127.0.0.1:9",
  "gitleaks git --no-banner . ; echo push",
  // Data behind shell grammar, and git's other options with a push word that is data.
  "for f in a b; do echo git push; done",
  "for w in git push; do echo \"$w\"; done",
  "{ echo git push; }",
  "if true; then echo git push; else echo git push; fi",
  "if false; then :; elif true; then echo git push; fi",
  "while false; do echo git push; done",
  "until true; do echo git push; done",
  "! echo git push",
  "A=1 echo git push",
  "grep -n git push notes.md",
  "egrep git push notes.md",
  "fgrep git push notes.md",
  "rg git push notes.md",
  "test git = push",
  "[ git = push ]",
  "[[ git == push ]]",
  ": git push",
  "export X=git Y=push",
  "git --git-dir .git --work-tree . --namespace x --super-prefix y --attr-source z log --grep push",
  "V=a git --config-env=a.b=V -c a.b=c -C . log --grep push",
  "git -p -P -v --paginate --no-pager --no-replace-objects --no-lazy-fetch --no-optional-locks --no-advice --bare log --grep push",
  "git --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --html-path --man-path --info-path log --grep push",
  "git --git-dir=.git --work-tree=. --namespace=x log --grep push",
  "git -- log --grep push",
  "# git -C . push\ntrue",
  "true # sh -c 'git push'",
  "git status # no push",
  'X="git -C . push"',
  "cat <<-EOF\n\tgit -C . push\n\tEOF",
  "(cat <<A)\ngit -C . push\nA",
  // An unquoted body runs only what stands in a substitution: the word next to one is text.
  "cat <<EOF\n$(date)\non: push\nEOF",
  "cat <<EOF\n`date`\non: push\nEOF",
  // A shell's or a dashed program's name decides where a program's name stands, and no other word does.
  "ls source push",
  "ls sh push",
  "ls /opt/git-core/git-push",
  "echo git push | tee sh",
  "nice ls push",
  // Naming an alias is no setting it: a verb of that name is that verb.
  "git commit -qm 'alias.commit=push'; git commit -qm x",
  'git log --grep="alias.log=push"; git log -1',
  // zsh's `=(…)` and an array read the same.
  "a=(1 2); echo git push",
  // A word that holds "push" and is no push word.
  "node --test test/push-spellings.test.mjs",
  "cat adapters/claude-code/push-spellings.mjs",
  "git checkout -b feat/git-push-hook",
  "git checkout -b fix/git-push",
  "git log origin/feat/git-push-hook",
  "git rebase origin/feat/git-push-hook",
  "sh -c 'cat push-spellings.mjs'",
  "bash scripts/push.sh",
  "git remote set-url --push origin x",
  "push?.sh",
  "sh -c 'ls x-push'",
  "sh -c 'ls fix/push'",
  "sh -c 'ls fix.push'",
  "sh -c 'ls repush'",
  "sh -c 'ls fix/git-push-hook'",
  // Other programs' push, and git's other verbs.
  "git stash push -m wip",
  "git -C . stash push",
  "git -C wt status",
  "git -C wt log --oneline -3 | cat",
  "git -c core.fsmonitor= status",
  "git -c user.name=x commit -qm y",
  "git --no-pager log -1",
  'git -C "$D" rev-parse HEAD',
  "git -C $D log -1 && echo done",
  "docker push ghcr.io/x/y:1",
  "podman push x",
  "helm push x",
  "npm run push",
  "node scripts/ennyn.mjs push-check",
  "adb push a b",
  "pushd . && popd",
  "ls push",
  "find . -name push",
  "git-receive-pack x",
  "git help push",
  "git config --get remote.origin.pushurl",
  "git config --global push.default simple",
  "git config alias.st status",
  "git log -S 'git -C . push'",
  // A shell, an xargs, a find and a built word with no push word anywhere: nothing is refused.
  "sh -c 'git status'",
  "bash -euo pipefail -c 'npm test'",
  "git ls-files | xargs git add",
  "echo a | xargs -I{} git log {}",
  "find . -maxdepth 1 -exec git log -1 {} \\;",
  "eval \"$(ssh-agent -s)\"",
  "echo status | sh",
  "cat <<EOF | sh\ngit status\nEOF",
  "trap 'rm -f x' EXIT",
  "watch -n1 git status",
  "source ~/.nvm/nvm.sh && nvm use 22",
  '"$GIT" status',
  "$(command -v node) -e 1",
  'for f in *.json; do echo "$f"; done',
  '"$BIN" --version',
  'echo "${A:-push}"',
  'echo "$(git log -1)" push',
  // A push word elsewhere does not reach a shell or a script that has none of its own.
  "git commit -qm 'push it' && bash x.sh",
  "git commit -qm 'push it' && sh -c 'git status'",
  'printf "on: push\\n" > ci.yml && "$R/try.sh" ci.yml',
  "git commit -qm 'push it' && source x.sh",
  // A built word at git's verb place, with no push word: the false refusals of the reader's first shape.
  'o="-c a=b"; git $o diff HEAD',
  "for c in status log; do git $c; done",
  "git ${GIT_FLAGS:-} status",
  'V=status; git "$V"',
  'g() { git -c user.name=t "$@"; }; g commit -qm x',
  't() { git "$@" > /dev/null 2>&1; }\nt log -1',
  "git {status,log}",
  // An expansion keeps its quoting: an apostrophe in one is no quote, and an arithmetic shift no here-document.
  'echo "${x:-it\'s}"',
  "x=$((1 << 3)); echo 'git -C . push'",
  // Spread words that are no verb, and a built program given text.
  "git add src/*.js",
  "git diff HEAD~1 -- '*.md'",
  "git log --format='{a,b}'",
  "ls *.md | xargs git add",
  "git stash push -- src/*.js",
  'echo "git -C . push" | "$PAGER"',
  '"$BIN" -c "git status"',
  "env -S 'git status'",
  "{ls,-la}",
  // A word is no verb, a text is no pipe.
  "echo git push || sh",
  "echo push | grep git",
  // A word built after a program that only names git.
  "ls -la $G/git $G/git-receive-pack",
  'cat "$M/gp/git" "$M/gp/git-receive-pack"',
  'ln -s /opt/tools/git/bin/git "$W/git"',
];

/** Commands that reach a push outside the shape left alone: refused. */
const REFUSED = [
  // Anything but plain words and list separators, anywhere in the text. Claude Code's parser gives up on more than can be
  // listed, and when it gives up the rule reads only the whole text: these ran unasked, on ordinary words
  // (test/reference/pretooluse.json). A comment holding an apostrophe, here-documents, a budget spent over the whole text.
  "git add . > /dev/null # don't show it\ngit commit -qm x\ngit push origin main",
  "npm test > out.log 2>&1 # it's slow\ngit push origin main",
  `${"$( (:));".repeat(12)}\ngit push origin main`,
  "for i in a # it's\ndo :; done\ngit push origin main",
  "git commit --allow-empty -qF - <<'E'\nEnd of the first pass (see below)\nE\ngit push origin main",
  'git commit --allow-empty -qm "$(cat <<\'EOF\'\nEOFs are (not) fine\nEOF\n)" && git push',
  'git commit --allow-empty -m "$(cat <<\'EOF\'\nsubject\n\nit\'s the body\nEOF\n)" && git push',
  "cat <<'E'\"F\"\nbody\nEF\ngit push",
  "cat <<'A' <<'B'\none\nA\ntwo\nB\ngit push",
  "cat <<< x; git push",
  // What the language bars with no case to it: each of these the rule would ask about, and each is refused once.
  "git push < /dev/null",
  'cd "x y" && git push origin main',
  "git commit --allow-empty -qm \"a (b) } it's\" && git push",
  "git commit --allow-empty -qm 'run `x` (y)' && git push",
  'git commit --allow-empty -qm "subject\n\nbody (x)\nEOF)\n" && git push',
  "echo $(date); git push",
  "echo $(echo $(date)); git push",
  "echo `date`; git push",
  "echo `echo \\`date\\``; git push",
  "echo $((1 + 2)); git push",
  "[[ -d x ]] && git push",
  "[ -d x ] && git push",
  "for f in a b; do echo $f; done; git push",
  "case x in a) echo;; esac; git push",
  "f() { echo; }; git push",
  "function f { echo; }; git push",
  "(echo a); git push",
  "echo a > b # no quote at all\ngit push origin main",
  "git push origin main # done",
  "true & git push",
  "git commit --allow-empty -qm x\n\tgit push origin main",
  // zsh's grammar. In zsh these are a word that stops at a brace of its own, and a glob, which are no comment and no redirect.
  "case x { a) :;; } | git push origin main",
  "echo (a)# | git push origin main",
  "echo x(a)# | git push origin main",
  "echo ((a))# | git push origin main",
  "echo <-> | git push origin main",
  // Nesting.
  "echo $(echo $(echo $(date))); git push",
  "(((true))); git push",
  // A push the rule's text match cannot see: the verb split by a line continuation.
  "cd . && git pu\\\nsh",
  "git push \\\n  origin main",
  // A background or `|&`: no separator of the list.
  "git push & wait",
  "echo a & git push",
  "git push |& tail -3",
  // Inside a block, a group, a subshell, on a line of its own or not.
  "if true; then\n  git push\nfi",
  "for r in origin; do\n  git push $r\ndone",
  "while true; do\n  git push\n  break\ndone",
  "case x in x)\n  git push;;\nesac",
  "f() {\n  git push\n}\nf",
  "function f {\n  git push\n}\nf",
  "{\n  git push\n}",
  "(\n  git push\n)",
  "(cd sub && git push)",
  // Words that are not literal, and text after it that is no redirect.
  "git push origin $B",
  "git push # a note",
  "{ git push; } 2>&1 | tee /dev/null",
  "if [ -d x ]; then git push; else git push origin main; fi",
  "for r in origin; do git push $r; done",
  "git \\\n  push",
  "g''it push",
  "g\\it push",
  "'git' push",
  '"/usr/bin/git" push',
  "./git push",
  "GIT_TERMINAL_PROMPT=0 git push origin main",
  "env -u X git push",
  "timeout -k 1 5 git push",
  "nice -n 5 git push",
  "sudo -u x git push",
  "stdbuf -oL git push",
  "echo $(git push)",
  "x=$(git push)",
  "> /dev/null git push origin main",
  "2>&1 git push origin main",
  'git push origin "main"',
  "git push origin $(echo main)",
  // An option before push.
  "git -C . push",
  "git -C sub push origin main",
  'git -C "." push',
  "git -c core.x=y push",
  "git --no-pager push",
  "git -P push",
  "git --git-dir=.git push",
  "git --git-dir .git --work-tree . push",
  "git -- push",
  "cd x && git -C .. push origin HEAD:main",
  "command git -C . push",
  "exec git -C . push",
  "\\git -C . push",
  "/usr/bin/git -C . push",
  "nice -n5 git -C . push",
  "true && git -C . push; echo done",
  // An option no table holds: it may take a value, so it hides the verb.
  "git --shallow-file /dev/null push origin main",
  // A quoted or escaped push.
  'git "push"',
  "git 'push'",
  "git $'push'",
  'git p""ush',
  "git \\push",
  "git pu\\sh",
  "\\git \\push",
  "$'git' push",
  "git pu${E}sh",
  // A command fed to a shell or another program.
  "sh -c 'git push'",
  "bash -c 'git push'",
  "zsh -c 'git push'",
  "bash -lc 'git push origin main'",
  "sh -ec 'cd x && git -C .. push'",
  'bash -c "git push"',
  "/bin/sh -c 'git push'",
  "bash --norc -c 'git push'",
  "bash -euo pipefail -c 'git push'",
  "bash -o pipefail -c 'git push'",
  "bash --rcfile /dev/null -c 'git push'",
  "bash +e -c 'git push'",
  "sh -c 'sh -c \"git push\"'",
  "timeout 5 sh -c 'git push'",
  "eval git push",
  'eval "git push"',
  "eval 'git -C . push'",
  'eval "$(echo git -C . push)"',
  'f() { eval "$1"; }; f \'git -C . push\'',
  'f() { sh -c "$1"; }; f \'git -C . push\'',
  "source <(echo git -C . push)",
  ". <(echo git -C . push)",
  ". /dev/stdin <<< 'git -C . push'",
  "echo push | xargs git",
  "echo x | xargs -I{} git push",
  "xargs git <<< push",
  "xargs git <<EOF\npush\nEOF",
  "echo push | cat | xargs git",
  "echo push | env xargs git",
  "echo git push | sh",
  "printf 'git push\\n' | bash",
  "cat <<EOF | sh\ngit push\nEOF",
  "cat <<EOF | tee /dev/null | sh\ngit -C . push\nEOF",
  'sh <<< "git push"',
  'sh <<<"$(echo git -C . push)"',
  "bash <<'EOF'\ngit push\nEOF",
  "bash -s <<EOF\ncd x\ngit push origin main\nEOF",
  "sh <(echo git -C . push)",
  "sh < <(echo git -C . push)",
  "sh /dev/stdin <<< 'git -C . push'",
  "echo git -C . push | sh /dev/stdin",
  "echo git -C . push | sh -s",
  "echo git -C . push | cat | sh",
  "{ echo git -C . push; } | sh",
  "(echo git -C . push) | sh",
  "echo git -C . push | (sh)",
  "echo git -C . push | { sh; }",
  "echo git -C . push | env sh",
  "echo 'git -C . push' > >(sh)",
  "exec 3<<<'git -C . push'; sh <&3",
  "git log -1 --format='format:git -C . push' | sh",
  "find . -maxdepth 0 -exec git push \\;",
  "find . -maxdepth 0 -exec sh -c 'git push' \\;",
  "find . -maxdepth 0 -execdir git push \\;",
  "trap 'git push' EXIT",
  "caffeinate -i git push",
  "caffeinate git push",
  "timeout 5 -- git push",
  "sudo -- git -C . push",
  "git submodule foreach 'git push origin HEAD:refs/heads/x'",
  "git rebase --exec 'git push origin HEAD:main' HEAD~1",
  "git bisect start HEAD HEAD~2 && git bisect run git push origin HEAD:main",
  // A command word built as it runs.
  "$(echo git) push",
  "`echo git` push",
  "`git push`",
  "$(echo git push)",
  "`echo git push`",
  "$(echo git -C . push origin main)",
  "git${IFS}push",
  "git ${X:-push}",
  "${X:-git} push",
  "${X:-git} ${Y:-push}",
  "${X:-git -C . push origin main}",
  "git $(echo push)",
  "git `echo push`",
  "x=$(`git push`)",
  'V=push; git "$V"',
  "for c in status push; do git $c; done",
  'g() { git "$@"; }; g push',
  'g() { git "$@"; }; g pu""sh',
  "sh -c 'git \"$@\"' _ push",
  "nice$X git push origin main",
  // On a disk that folds case this is git, and the rule reads only the lower-case name. The same for what runs text.
  "GIT push",
  "Git -C . push",
  "BASH -c 'git -C . push'",
  "SH -c 'git -C . push'",
  "XARGS git <<< push",
  "ENV -S 'git -C . push'",
  "echo git -C . push | BASH",
  // A wrapper before a built word, or a dot.
  "env $(echo git) push origin main",
  "env $(echo git -C . push)",
  "command $(echo git) push origin main",
  "exec ${X:-git} push origin main",
  "nohup `echo git` push origin main",
  "env A=1 $(echo git -C . push)",
  "nice git${IFS}push origin main",
  "command . /dev/stdin <<< 'git -C . push'",
  "builtin . /dev/stdin <<< 'git -C . push'",
  // A built word glued to a name that runs nothing is no such name.
  "$(echo git push origin HEAD:refs/heads/)echo",
  "$(echo git -C . push origin HEAD:refs/heads/)grep",
  // A word a shell spreads before it runs, and a name only zsh expands: the rule stopped none of these.
  "git {push,}",
  "git pu{s,}h",
  "git -C . {push,}",
  "git -C . pu{s,}h",
  "{git,push}",
  "{git,} push",
  "=git push",
  "=git -C . push",
  // A shell or a splitter named some other way, or put together.
  "$SHELL -c 'git -C . push'",
  '"$(command -v bash)" -c \'git push\'',
  "$'\\x73h' -c 'git -C . push'",
  "/bin/s? -c 'git -C . push'",
  "env -S 'git -C . push'",
  "env --split-string='git -C . push'",
  "env -vS 'git -C . push'",
  "nice env -S 'git -C . push'",
  // git is not the first word named git.
  "env -u git git -C . push",
  "sudo -g git git -C . push",
  "flock /tmp/git git -C . push origin main",
  "flock /tmp/l -c 'git -C . push'",
  // zsh's process substitution, as the other two.
  "sh =(echo git -C . push)",
  ". =(echo git -C . push)",
  // su runs what it is given; a positional in braces is as good as one without.
  "su -c 'git -C . push'",
  'f() { eval "${1}"; }; f \'git -C . push\'',
  // Another way to the same place.
  "git send-pack origin HEAD",
  "git http-push x",
  "git subtree push --prefix=x origin main",
  '"$(git --exec-path)/git-push" origin main',
  "/opt/git-core/git-push origin",
  // An alias: a verb that names one is a push, whatever it expands to.
  "git -c alias.save=push save",
  "git -c alias.save='!git push' save",
  'git -c "alias.save=$(echo push)" save',
  "git -c alias.save.command=push save",
  "git -c alias.a.b.command=push a.b",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.a.b.command GIT_CONFIG_VALUE_0=push git a.b",
  "git -c alias.a=b -c alias.b=push a",
  "git -c alias.save='!git' save push origin main",
  "V=push git --config-env=alias.save=V save",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.save GIT_CONFIG_VALUE_0=push git save",
  "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.save GIT_CONFIG_VALUE_0=push git save",
  "GIT_CONFIG_PARAMETERS=\"'alias.save=push'\" git save",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.save GIT_CONFIG_VALUE_0=push; git save",
  'GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=alias.save; GIT_CONFIG_VALUE_0="!git push"; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0\ngit save',
  // Past the stand-alone command: a refused one in a substitution, a pipeline, a long script.
  'echo "$(git -C . push 2>&1)"',
  "x=$(git -C . push)",
  'git commit --allow-empty -qm "$(cat <<\'EOF\'\nit\'s done\nEOF\n)" && git -C . push',
  "cat <<'EOF' > y\ndone\nEOF\ngit -C . push",
  "echo ${x:-$(git -C . push)}",
  'echo "${x:-$(git -C . push)}"',
  '[ -n "$(git -C . push)" ]',
  'cat <<< "$(git -C . push)"',
  "x[$(git -C . push)]=1",
  // A substitution in an unquoted here-document runs.
  "cat <<EOF\n$(git -C . push)\nEOF",
  "cat <<EOF\n`git -C . push`\nEOF",
  "git commit --allow-empty -qF - <<EOF\n$(git -C . push)\nEOF",
  // A word the cleaner would erase with the substitution that holds it.
  "cat <<EOF\n$(git -C . pu\"\"sh)\nEOF",
  "cat <<EOF\n$(git -C . p\\ush)\nEOF",
  "cat <<EOF\n`git -C . pu\"\"sh`\nEOF",
  "bash -c 'echo $(git -C . pu\"\"sh)'",
  "sh -c 'x=$(git -C . pu\"\"sh)'",
  "eval 'x=$(git -C . pu\"\"sh)'",
  "sh <<'EOF'\nx=$(git -C . pu\"\"sh)\nEOF",
  // What the pass must keep apart, each on the way to a push.
  "git -C . \\\n  push",
  "echo $'it\\'s' && git -C . push",
  "cat <<-EOF\n\ttext\n\tEOF\ngit -C . push",
  "echo ${#a} && git -C . push",
  "git 2>/dev/null -C . push",
  "cat <(git -C . push)",
  "echo git push |& sh",
  "command eval 'git push'",
  "git.exe -C . push",
  // A hash inside an expansion is no comment; an apostrophe in a double-quoted expansion is no quote.
  "echo ${x:- # }; git -C . push",
  "echo ${x:-a #b}; git -C . push",
  'echo "${x:-\'}"; git -C . push; echo "\'"',
  'echo "${X:-it\'s}" && git -C . push # it\'s',
  'echo "${x:-\'}"; git -C . push; echo "\'}"',
  // A here-document that does not close where the reader thinks: a shell takes a delimiter's expansion literally.
  "cat <<$X\nhello\n$X\ngit -C . push",
  "cat <<${X}\nhello\n${X}\ngit -C . push",
  // A backtick body is unescaped before it is read.
  "echo `echo \\`git -C . push\\``",
];

/** Refused and no push: the price of not following, accepted and pinned. */
const OVER_STOPS = [
  '"$DOCKER" push x',
  "$(command -v docker) push x",
  "timeout 5 echo git -C . push",
  "ls git push",
  "ssh host git push",
  "bash -c 'cd x && npm test 2>&1 | grep push'",
  "bash -lc \"git log | grep 'git push'\"",
  "find . -name '*.mjs' -exec grep -l push {} +",
  'eval "echo git push"',
  "sh <<EOF\necho git push\nEOF",
  "bash scripts/deploy.sh push",
  'run() { git -C "$R" "$@"; }; run status; echo "before push"',
  "git -c alias.st=status st",
  "git --no-such-option log --grep push",
  "scripts/{push,pull}.sh",
  "find . -maxdepth 0 -execdir printf 'git -C . push' \\;",
  // One push word anywhere arms what runs text it is fed, an unrelated command's included.
  "git log --grep push; ls | xargs echo",
  "git log --grep push | tail -1; echo x | sh",
  // A shift outside `$((…))` reads as a here-document, and text that does not close is judged by the word.
  "((x = 1 << 2))\necho push",
  // A comment right after a parenthesis: in zsh a `#` there can be part of a glob, so it is read as text.
  "(echo a)# git push",
  // An alias definition runs nothing until it is called.
  "alias p='git -C . push'",
];

/**
 * Text no shell finishes, or the reader cannot: a quote, a substitution or a here-document left open is judged by the push
 * word, wherever it stands. A shell refuses most of these and runs nothing; refusing one of them costs the agent one more
 * try at a command that was broken anyway. An open here-document runs.
 * @type {[string, boolean][]}
 */
const UNFINISHED = [
  ['git -C . push "open', true],
  ["echo ok && git -C . push 'open", true],
  ["sh -c 'git push", true],
  ["git -C . push $(", true],
  ["git -C . push `open", true],
  ["echo ${x:-open git -C . push", true],
  ["(git status; echo push", true],
  ["sh <<EOF\ngit push", true],
  ['echo "open git -C . push', true],
  ["cat <<EOF\ngit -C . push", true],
  ["cat <<EOF; git -C . push", true],
  ["cat <<EOF; echo push", true],
  ["echo `echo 'open` push", true],
  ["git status 'open", false],
  ['git commit -m "open', false],
  ["git status $(", false],
  ["cat <<EOF\ngit status", false],
  ["cat <<EOF\ngit status\nEOF", false],
  ["\\", false],
  ["", false],
];

test("push reader: text that does not close is judged by the push word, and a shell's answer is stated", () => {
  for (const [c, refused] of UNFINISHED) assert.equal(pushSpelling(c) !== null, refused, JSON.stringify(c));
});

test("push reader: past what it can read, the push word decides, with quotes removed: nesting deeper than a stack, text over the ceiling", () => {
  // Just under the ceiling, deeper than any stack.
  for (const open of ["$(", "(", "${"]) {
    const deep = (/** @type {string} */ text) => open.repeat(Math.floor(65000 / open.length)) + text;
    assert.notEqual(pushSpelling(deep("git -C . push")), null, open);
    assert.notEqual(pushSpelling(deep('git -C . pu"s"h')), null, open);
    assert.notEqual(pushSpelling(deep("git -C . p\\ush")), null, open);
    assert.equal(pushSpelling(deep("git status")), null, open);
  }
  // Closed nesting ahead of a push: the stack gives out, and what stands after it is still seen.
  assert.notEqual(pushSpelling(`echo ${"$(".repeat(30000)}${")".repeat(30000)}; git -C . pu""sh`), null);
  // The ceiling: at it the text is read, past it a push word refuses it unread, and with none nothing does.
  const at = (/** @type {number} */ n, /** @type {string} */ end) => "#".repeat(n - end.length) + end;
  assert.equal(pushSpelling(at(65536, "\n# push")), null);
  assert.notEqual(pushSpelling(at(65537, "\n# push")), null);
  assert.equal(pushSpelling(at(65537, "\ngit status")), null);
  assert.notEqual(pushSpelling(at(1 << 21, '\ngit -C . pu""sh')), null);
  assert.notEqual(pushSpelling(at(1 << 21, "\ngit -C . pu${E}sh")), null);
  assert.notEqual(pushSpelling(at(1 << 21, "\ngit -C . pu$(:)sh")), null);
  assert.notEqual(pushSpelling(at(1 << 21, "\ngit -C . pu`:`sh")), null);
  assert.notEqual(pushSpelling(at(1 << 21, "\ngit -C . pu\\\nsh")), null);
  // A push stops being left at 9,000 characters, under the 10,000 past which Claude Code's parser stops, on its own or not.
  const plain = (/** @type {number} */ n) => `git push origin ${"a".repeat(n - 16)}`;
  assert.equal(pushSpelling(plain(8999)), null);
  assert.notEqual(pushSpelling(plain(9000)), null);
  assert.notEqual(pushSpelling(plain(70000)), null);
  const compound = (/** @type {number} */ n) => `: ${"a".repeat(n - 26)} && git push origin main`;
  assert.equal(compound(8999).length, 8999);
  assert.equal(pushSpelling(compound(8999)), null);
  assert.notEqual(pushSpelling(compound(9000)), null);
});

test("push reader: a push is left only in a text with nothing to misread: plain words, space, newline, `;`, `|`, `>`, `&&` and `2>&1`, and no other character anywhere", () => {
  for (const c of ["cd x && git push", "git add . && git commit -qm x && git push origin main 2>&1 | tail -3", "git fetch origin\ngit push > out 2>&1"]) assert.equal(pushSpelling(c), null, c);
  // One character of anything else, before the push or after it, refuses a push that is plain itself; with no push nothing does.
  for (const piece of ["'a'", '"a"', "$x", "`a`", "$(a)", "(a)", "{a}", "a{b", "a}b", "[a]", "a[b", "a]b", "a*", "a?", "# a", "a # it's", "<a", "<<a", "<<<a", "a & b", "a\\b", "!a", "\ta", "\ra"]) {
    assert.notEqual(pushSpelling(`echo ${piece}\ngit push`), null, piece);
    assert.notEqual(pushSpelling(`git push; echo ${piece}`), null, piece);
    assert.equal(pushSpelling(`echo ${piece}\ngit status`), null, piece);
  }
  // Each line of the language's separators, and what only looks like one. `2>&1` is a token: no other descriptor, no `&>`, no `|&`.
  for (const c of ["true;git push", "true&&git push", "false||git push", "echo a|git push", "true &&\ngit push", "echo a |\ngit push", "echo a >> b; git push", "echo a >| b; git push", "ls 2>&1 | tail -1; git push"]) assert.equal(pushSpelling(c), null, c);
  for (const c of ["ls 1>&2; git push", "ls 2>&-; git push", "ls &> out; git push", "ls |& tail -1; git push", "ls &; git push", "ls &\ngit push", "git push &"]) assert.notEqual(pushSpelling(c), null, c);
  // One space between words: the rule's text match is the reason.
  assert.notEqual(pushSpelling("git push  origin main"), null);
  assert.notEqual(pushSpelling("git  push"), null);
  // A word of the left shape holds nothing a shell would touch, in a compound as on its own.
  for (const word of ["HEAD^:main", "~/x", "%a", "+b", "=c", "a,b", "u@h", "v.1", "x/y", "--force-with-lease=main:abc"]) {
    assert.equal(pushSpelling(`git push origin ${word}`), null, word);
    assert.equal(pushSpelling(`true; git push origin ${word}`), null, word);
  }
  // A redirect after it goes to a literal place, and nothing stands before it.
  for (const c of ["git push > out", "git push >> out", "git push >out", "git push 2> err", "git push > /dev/null 2>&1", "git push 2>&1 > out", "git push origin main 2>&1"]) assert.equal(pushSpelling(c), null, c);
  for (const c of ["git push > $OUT", 'git push 2> "x y"', "git push < in", "git push 12> out", "git push > ~/out", "git push > a=b", "> out git push", "2>&1 git push", "A=1 git push", "! git push", "time git push", "then git push", "- git push", "=git push", "./git push", "/usr/bin/git push"]) assert.notEqual(pushSpelling(c), null, c);
  // Every push of the text is left, or none: one refused one refuses it.
  assert.notEqual(pushSpelling("git push; git -C . push"), null);
  assert.notEqual(pushSpelling("git -C . push; git push"), null);
  // A block is counted by its words at a command's head: a push inside one is no command of the top-level list.
  assert.notEqual(pushSpelling("fi\ngit push"), null);
  for (const block of ["if true; then", "for x in a; do", "while true; do", "until false; do", "select x in a; do", "case x in", "function f"]) {
    assert.notEqual(pushSpelling(`${block}\n  git push\n`), null, block);
    assert.notEqual(pushSpelling(`${block}\ngit push\n`), null, block);
  }
  assert.equal(pushSpelling("if true; then echo a; fi\ngit push"), null);
  assert.equal(pushSpelling("while false; do echo a; done\ngit push"), null);
  assert.equal(pushSpelling("case x in\nesac\ngit push"), null);
  // A `#` right after `)` is no comment: zsh's glob `(a)#` is one word, and what follows it runs. A `#` anywhere else starts one.
  for (const c of ["echo (a)# | git push origin main", "echo x(a)# | git push origin main", "echo (a)## | git push origin main", 'echo "a"(b)# | git push origin main']) assert.notEqual(pushSpelling(c), null, c);
  for (const c of ["echo (a) # | git push origin main", "(echo a)# no word of it", "echo a # git push", "git status # push", "# git push", "echo a;# git push"]) assert.equal(pushSpelling(c), null, c);
  // A redirect with no target ends with its command and does not take the next command's first word.
  assert.notEqual(pushSpelling("echo <-> | git push origin main"), null);
  assert.notEqual(pushSpelling("echo <1-2> | git push origin main"), null);
  assert.notEqual(pushSpelling("ls <-> | git -C . push"), null);
  assert.equal(pushSpelling("echo <-> | git status"), null);
});

test("push reader: on hostile text just under the ceiling its time grows with the text: four times as long takes about four times as long", () => {
  const fill = (/** @type {string} */ s, /** @type {number} */ n) => s.repeat(Math.floor(n / s.length));
  /** @type {Record<string, (n: number) => string>} */
  const shapes = {
    "git words in a rebase": (n) => `git rebase ${fill("git ", n)}x`,
    "git and an option": (n) => `nice ${fill("git -C ", n)}`,
    "alias words": (n) => `git ${fill("alias.a=b ", n)}x`,
    "alias glued": (n) => `git ${fill("alias.", n)} x`,
    "here-documents": (n) => fill("cat <<A\nA\n", n),
    assignments: (n) => `${fill("a=1 ", n)}git status`,
    backticks: (n) => fill("`a`", n),
    commands: (n) => fill("git status;", n),
    "a built verb per command": (n) => `${fill('git "$@";', n)}git pu\\sh`,
    "an open brace": (n) => `git ${fill("{", n)}`,
    "a long option": (n) => `sh -${fill("c", n)}!`,
    "shells fed by pipes": (n) => `${fill("a b | sh | ", n)}c`,
    "aliases set in a nested read": (n) => `${fill("eval GIT_CONFIG_KEY_0=alias.x\n", n)}git -C . push`,
  };
  const spent = (/** @type {string} */ text) => {
    const start = process.cpuUsage();
    pushSpelling(text);
    const { user, system } = process.cpuUsage(start);
    return (user + system) / 1000;
  };
  for (const [id, make] of Object.entries(shapes)) {
    const small = spent(make(15 * 1024));
    const large = spent(make(60 * 1024));
    assert.ok(make(60 * 1024).length <= 65536, id);
    // Linear is four; a square would be sixteen. The floor keeps a run of a few milliseconds from deciding.
    assert.ok(large < Math.max(small * 9, 400), `${id}: 15 KiB ${small} ms, 60 KiB ${large} ms`);
  }
});

test("push reader: after a wrapper any word stands where a program's name stands, and only there does a name decide", () => {
  for (const wrapper of ["env", "command", "builtin", "exec", "nohup", "nice", "ionice", "time", "timeout", "gtimeout", "sudo", "doas", "stdbuf", "caffeinate", "setsid", "busybox", "toybox", "chroot", "script", "noglob", "nocorrect"]) {
    assert.notEqual(pushSpelling(`${wrapper} sh -c 'git -C . push'`), null, wrapper);
    assert.notEqual(pushSpelling(`${wrapper} $(echo git) push`), null, wrapper);
    assert.notEqual(pushSpelling(`${wrapper.toUpperCase()} sh -c 'git -C . push'`), null, wrapper);
    assert.equal(pushSpelling(`${wrapper} git status`), null, wrapper);
  }
  assert.notEqual(pushSpelling("script -q /dev/null sh -c 'git -C . push origin main'"), null);
  // An assignment after env is no program.
  assert.equal(pushSpelling("env A=$B npm run push"), null);
  // A dashed program's name folds case as git's does.
  assert.notEqual(pushSpelling("GIT-PUSH origin"), null);
  assert.notEqual(pushSpelling("git-push origin"), null);
});

test("push reader: the accept corpus is left alone", () => {
  for (const c of LEFT) assert.equal(pushSpelling(c), null, JSON.stringify(c));
});

test("push reader: the reject corpus is refused", () => {
  for (const c of REFUSED) assert.notEqual(pushSpelling(c), null, JSON.stringify(c));
});

test("push reader: what it refuses that is no push is the price of not following: each is refused", () => {
  for (const c of OVER_STOPS) assert.notEqual(pushSpelling(c), null, JSON.stringify(c));
});

test("push reader: the left shape", () => {
  for (const c of ASKED) assert.equal(pushSpelling(c), null, JSON.stringify(c));
});

test("push reader: every spelling Claude Code ran under Bash(git push *) is refused, and what is left the rule stopped", () => {
  const cells = readRecord().cells.filter((c) => c.id.startsWith("spelling-"));
  assert.ok(cells.length >= 60, String(cells.length));
  let left = 0;
  for (const c of cells) {
    const { command } = SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (/** @type {{ Bash: string }} */ (c.call).Bash)];
    if (pushSpelling(command) !== null) continue;
    assert.notEqual(c.cc?.call, "ran", `${c.id}: ${command}: left, and Claude Code ran it`);
    left++;
  }
  assert.ok(left >= 3, String(left));
});

/**
 * Lines a run here says nothing about: a program this test does not hand the shell or must not start, a path or a case-folded
 * name of a git it has not got, a program git leaves out of some builds, a remote that is no repository.
 */
const NOT_RUN = /^(GIT push|Git -C|BASH |SH |XARGS |ENV |echo git -C \. push \| BASH|\$SHELL|caffeinate|timeout|nice|nohup|exec |command |builtin |su |env -u|sudo|stdbuf|watch|docker|podman|helm|adb|npm|node|rg|ssh|flock|man |pushd|source ~|bash -lc|bash --norc|bash --rcfile|=git|\.\/git|\/opt\/|\/usr\/bin\/git|\/bin\/|"\/usr\/bin\/git|git\.exe|git subtree|git send-pack|git http-push|"\$\(git --exec-path|V=push git --config-env|\$\(command -v|"\$DOCKER|"\$\(command -v|x\[\$|\$'\\x73h')|ssh-agent|PAGER|\$BIN|env -vS|split-string|alias\.\S+\.command/;

/** Whether a line the stand-in wrote asks git to send: the verb past git's own options. @param {string} line */
function sends(line) {
  const words = line.split(" ");
  let v = 0;
  for (; words[v]?.startsWith("-"); v++) if (["-C", "-c", "--git-dir", "--work-tree"].includes(words[v])) v++;
  return ["push", "send-pack", "http-push"].includes(words[v]);
}

test("push reader: a real shell and a real git agree: what is refused reaches a push and what is left as text reaches none", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-push-shell-")));
  try {
    const bin = join(box, "bin");
    const log = join(box, "log");
    const received = join(box, "received");
    const cwd = join(box, "work");
    // A shell's startup file would run in every line, and a line's answer would be the developer's: this one would write
    // a file, and the run's end looks for it.
    const started = join(box, "started");
    const startup = join(box, "startup");
    writeFileSync(startup, `: > '${started}'\n`);
    const developer = { ...process.env, BASH_ENV: startup, ENV: startup, ZDOTDIR: box };
    const env = { ...developer, BASH_ENV: undefined, ENV: undefined, ZDOTDIR: undefined, PATH: bin, HOME: box, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const direct = { ...env, PATH: process.env.PATH };
    const git = (/** @type {string} */ dir, /** @type {string[]} */ ...args) => execFileSync(real, args, { cwd: dir, env: direct, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    mkdirSync(bin);
    // The bare remote logs a push and rejects it, so the next line's push shows too; the clone is ahead of it by three
    // commits, with a submodule of the same remote.
    mkdirSync(join(box, "remote.git"));
    git(join(box, "remote.git"), "init", "-q", "--bare", "-b", "main");
    git(box, "clone", "-q", "remote.git", "work");
    git(cwd, "commit", "-q", "--allow-empty", "-m", "one");
    git(cwd, "branch", "-M", "main");
    git(cwd, "push", "-q", "-u", "origin", "main");
    // A git built with no templates makes no hooks folder.
    mkdirSync(join(box, "remote.git", "hooks"), { recursive: true });
    writeFileSync(join(box, "remote.git", "hooks", "pre-receive"), `#!/bin/sh\ncat >> '${received}'\nexit 1\n`, { mode: 0o755 });
    git(cwd, "submodule", "add", "-q", "../remote.git", "module");
    git(cwd, "commit", "-q", "-m", "module");
    for (const m of ["two", "three"]) git(cwd, "commit", "-q", "--allow-empty", "-m", m);
    for (const dir of ["x", "x y", "sub"]) mkdirSync(join(cwd, dir));
    const start = git(cwd, "rev-parse", "HEAD").trim();
    // git writes its arguments and runs the real one; a second git behind a shell or an alias is seen by the remote.
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    // Only the programs named here are on PATH, git's own scripts' among them: a corpus line can reach nothing else.
    for (const name of ["sh", "bash", "zsh", "xargs", "find", "cat", "grep", "sed", "awk", "tee", "env", "nohup", "basename", "dirname", "uname", "tr", "rm", "mkdir", "cp", "mv", "ls", "wc", "cut", "sort", "expr", "head", "tail", "date"]) {
      const at = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (at) writeFileSync(join(bin, name), `#!/bin/sh\nexec ${at} "$@"\n`, { mode: 0o755 });
    }
    // Claude Code runs the user's shell, and shells differ here: zsh does not split ${IFS}, macOS's bash 3.2 cannot read
    // an apostrophe in a here-document inside $(…). A command reaches a push when any shell on this machine takes it there.
    const shells = ["bash", "zsh"].filter((name) => existsSync(join(bin, name)));
    const hasZsh = shells.includes("zsh");
    const reached = (/** @type {string} */ command) =>
      shells.some((shell) => {
        for (const f of [log, received]) writeFileSync(f, "");
        const r = spawnSync(join(bin, shell), ["-c", command], { cwd, env, input: "", encoding: "utf8", timeout: 20000 });
        assert.equal(r.signal, null, `${shell} did not end: ${command}`);
        const hit = readFileSync(received, "utf8") !== "" || readFileSync(log, "utf8").split("\n").some(sends);
        // The two lines a rejected push leaves half done.
        if (/^git (rebase|bisect)/.test(command)) {
          for (const undo of [["rebase", "--abort"], ["bisect", "reset"]]) spawnSync(real, undo, { cwd, env: direct, stdio: "ignore" });
          git(cwd, "checkout", "-q", "main");
          git(cwd, "reset", "-q", "--hard", start);
        }
        return hit;
      });
    let ran = 0;
    for (const c of REFUSED) {
      if (NOT_RUN.test(c) || (!hasZsh && /^(zsh|git\$\{IFS|\.? ?sh =\(|\. =\(|case x \{|echo x?\(+a|echo <->)/.test(c))) continue;
      assert.equal(reached(c), true, `refused, but no shell reaches a push: ${JSON.stringify(c)}`);
      ran++;
    }
    for (const c of ASKED) {
      assert.equal(reached(c), true, `left as a push, but no shell reaches one: ${JSON.stringify(c)}`);
      ran++;
    }
    for (const c of [...LEFT, ...OVER_STOPS]) {
      if (NOT_RUN.test(c)) continue;
      assert.equal(reached(c), false, `left, but a shell reaches a push: ${JSON.stringify(c)}`);
      ran++;
    }
    assert.ok(ran >= 200, `${ran} commands run`);
    assert.equal(existsSync(started), false, "a shell ran a startup file");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

/**
 * What the reader does not reach, on purpose: each reaches a push, each is left, and the module's header and SECURITY.md
 * name them. A limit that moves is seen here.
 */
const LIMITS = [
  // A script, an interpreter, another program that runs text.
  "sh push.sh",
  "./push.sh",
  "python3 -c 'import os; os.system(\"git push\")'",
  'node -e \'require("child_process").execSync("git push")\'',
  "awk 'BEGIN { system(\"git -C . push\") }'",
  "man -P 'git -C . push #' ls",
  "gh api repos/x/y/git/refs -f ref=refs/heads/x",
  // Another machine, in one quoted word.
  "ssh host 'cd r && git push'",
  // A command held in a variable, and a shell that evaluates text later.
  'P="git -C . push"; $P',
  'P="git -C . push"; eval "$P"',
  "G=git; V=push; $G $V",
  "read -r c <<< 'git -C . push'; $c",
  "x='a[$(git -C . push)]'; echo $((x))",
  // Text whose shell grammar the reader does not read: it sees no push. Claude Code holds these two today (pretooluse.json).
  "echo ${x:-{}; # }; git push origin main",
  "echo <1-2># | git push origin main",
  // Encoded words, and a word a run puts together.
  "git $'p\\x75sh'",
  "echo Z2l0IHB1c2g= | base64 -d | sh",
  "git pu$(echo sh)",
  "git pu?h",
  'set -- pu sh; git "$1$2"',
  "echo pu | xargs -I@ git @sh",
  "printf 'pu%s' sh | xargs git",
  // git under another name, and an alias in a file.
  "ln -s /usr/bin/git g && ./g -C . push",
  "hub push origin main",
  "git config alias.save push",
  "git config --global alias.save '!git push'",
  "printf '[alias]\\n\\ts = push\\n' >> .git/config && git s",
  // A git option or setting that runs a command.
  "git ls-remote --upload-pack='git -C . push; :' .",
  "git archive --remote=. --exec='git -C . push; :' HEAD",
  "git difftool -y -x 'git -C . push #' HEAD~1 HEAD",
  "git -c core.sshCommand='git -C . push #' fetch ssh://x/y",
  // PowerShell's own spellings, read as shell text: these are no shell words.
  'iex "git -C . push"',
  'Invoke-Expression "git -C . push"',
];

test("push reader: the stated limits are limits: each is left, and the header and SECURITY.md name it", () => {
  for (const c of LIMITS) assert.equal(pushSpelling(c), null, JSON.stringify(c));
  const header = readFileSync(fileURLToPath(new URL("../adapters/claude-code/push-spellings.mjs", import.meta.url)), "utf8").split("*/")[0];
  for (const word of ["shell grammar the reader does not read", "echo ${x:-{}; # }; git push origin main", "echo <1-2># | git push origin main", "unmeasured under load", "a script the agent writes", "an interpreter", "an MCP tool", "`gh api`", "another machine", "held whole in a variable", "encoded words", "a word a run puts together", "under another name", "an alias in a config file", "runs a command", "PowerShell's own spellings", "a Skill's shell block", "disableAllHooks", "NODE_OPTIONS", "crashes, is killed or times out", "no boundary", "hand-crafted", "a group, a function", "only if Claude Code's parser finishes"]) assert.ok(header.includes(word), word);
  const security = readFileSync(fileURLToPath(new URL("../SECURITY.md", import.meta.url)), "utf8");
  for (const word of ["shell grammar it does not read", "echo ${x:-{}; # }; git push origin main", "echo <1-2># | git push origin main", "unmeasured", "a script the agent writes", "an interpreter", "an MCP tool", "another machine", "held whole in a variable", "encoded words", "a word a run puts together", "under another name", "an alias in a config file", "disableAllHooks", "NODE_OPTIONS", "no boundary", "only if Claude Code's parser finishes"]) assert.ok(security.includes(word), word);
});

test("push reader: a PowerShell command is read as shell text: the same spellings, no second reader", () => {
  for (const c of ["git -C . push", 'git "push"', "& git -C . push", "$env:X = 1; git -C . push", "cd x; git -C . push"]) assert.notEqual(pushSpelling(c), null, c);
  for (const c of ["git push origin main", "cd x; git push", "git log --format=%h | Select-String push", 'Write-Output "git -C . push"', "Get-ChildItem -Recurse | Where-Object Name -Match push"]) assert.equal(pushSpelling(c), null, c);
});

test("push reader: a verb that names an alias in the environment is a push, whatever it expands to", () => {
  const set = (/** @type {string} */ key, /** @type {string} */ value) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });
  assert.deepEqual([...pushAliases(set("alias.save", "push"))], ["save"]);
  assert.deepEqual([...pushAliases(set("alias.save", "!git -C . push"))], ["save"]);
  // Whatever it expands to: a chain and a value with no push word are what a word would miss.
  assert.deepEqual([...pushAliases(set("alias.a", "b"))], ["a"]);
  assert.deepEqual([...pushAliases(set("alias.save.command", "push"))], ["save"]);
  assert.deepEqual([...pushAliases(set("alias.a.b.command", "push"))], ["a.b"]);
  assert.deepEqual([...pushAliases(set("core.editor", "push"))], []);
  assert.deepEqual([...pushAliases(set("my.alias.save", "push"))], []);
  // The two forms git writes, and a name in another case: git folds the key.
  assert.deepEqual([...pushAliases({ GIT_CONFIG_PARAMETERS: "'alias.save=push'" })], ["save"]);
  assert.deepEqual([...pushAliases({ GIT_CONFIG_PARAMETERS: "'alias.Save'='push' 'user.name'='x'" })], ["save"]);
  // Other variables are not read.
  assert.deepEqual([...pushAliases({ OTHER: "alias.save", GIT_CONFIG_VALUE_0: "alias.save" })], []);
  assert.notEqual(pushSpelling("git save origin", set("alias.save", "push")), null);
  assert.notEqual(pushSpelling("git SAVE origin", set("alias.save", "push")), null);
  assert.notEqual(pushSpelling("git a origin", set("alias.a", "b")), null);
  assert.notEqual(pushSpelling("git save", set("alias.save", "status")), null);
  assert.equal(pushSpelling("git status", set("alias.save", "push")), null);
  assert.equal(pushSpelling("git save"), null);
  // Past the ceiling nothing is read, so a set alias counts as a push word does.
  assert.notEqual(pushSpelling(`${"#".repeat(70000)}\ngit save`, set("alias.save", "push")), null);
  assert.equal(pushSpelling(`${"#".repeat(70000)}\ngit save`), null);
  // A name in a message is a name, and no verb calls it.
  assert.equal(pushSpelling('git commit -qm "refuse alias.save=push"'), null);
  assert.equal(pushSpelling('git log --grep="alias.save" -- docs/push.md'), null);
  // Set in the command, by each way git reads: only the word that sets it counts, and past the head of nothing.
  for (const c of ["git -c alias.go=push go", "V=push git --config-env=alias.go=V go", "GIT_CONFIG_KEY_0=alias.go git go", "export GIT_CONFIG_KEY_0=alias.go; git go", "GIT_CONFIG_PARAMETERS=\"'alias.go=push'\" git go"]) assert.notEqual(pushSpelling(c), null, c);
  for (const c of ["git commit -qm alias.go=push; git go", "echo alias.go=push; git go", "git log -S alias.go; git go"]) assert.equal(pushSpelling(c), null, c);
});

const HOOK = fileURLToPath(new URL("../adapters/claude-code/hooks/push-spellings.mjs", import.meta.url));
const neutral = mkdtempSync(join(tmpdir(), "en-push-cwd-"));

/** A repository, with an Ennyn config as `config` says: its text, or nothing. @param {string | null} config */
function project(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-push-hook-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (config !== null) {
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), config);
  }
  return dir;
}

/** The hook as Claude Code runs it. @param {string} dir @param {unknown} input @param {NodeJS.ProcessEnv} [env] @param {string[]} [before] */
function run(dir, input, env = {}, before = []) {
  const r = spawnSync(process.execPath, [...before, HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env }, cwd: neutral, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  return r;
}
const call = (/** @type {string} */ command, tool = "Bash") => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command, description: "x" }, cwd: neutral });
const decision = (/** @type {{ stdout: string }} */ r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;

/** A `git` first on PATH that writes each call to `log` and fails. @param {string} log */
function countingGit(log) {
  const bin = mkdtempSync(join(tmpdir(), "en-push-git-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 2\n`, { mode: 0o755 });
  return `${bin}${delimiter}${process.env.PATH}`;
}

test("push hook: with a config it denies a spelling on each tool that runs a command, says how to write the push, and exits 0", () => {
  const dir = project("{}\n");
  for (const tool of ["Bash", "Monitor", "PowerShell"]) {
    const r = run(dir, call("cd x && git -C . push origin main", tool));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /git -C \. push origin main/, "names what it read");
    assert.match(out.permissionDecisionReason, /`git push <remote> <branch>`/, "says how to write it");
    assert.match(out.permissionDecisionReason, /in a call of its own/);
    assert.match(out.permissionDecisionReason, /with the commit in the call before/);
    // Why, so the next call is written once: what refuses it.
    assert.match(out.permissionDecisionReason, /one quote, `\$`, comment, parenthesis, brace, backtick, backslash, `<` or lone `&` anywhere in it refuses it/);
    // The folder in one call: a `cd` in an earlier call does not carry in a subagent or out of the project.
    assert.match(out.permissionDecisionReason, /`cd <folder> && git push <remote> <branch>` from another folder/);
    assert.doesNotMatch(out.permissionDecisionReason, /earlier call/);
    // The rule asks only where a project holds it: the text does not promise more.
    assert.match(out.permissionDecisionReason, /rule then asks the user; a project with no such rule runs it/);
    assert.doesNotMatch(out.permissionDecisionReason, /script/, "a refusal names no way around it");
  }
});

test("push hook: what it names is one line, cut, and shown: a long or hostile command does not fill the reason", () => {
  const dir = project("{}\n");
  const reason = (/** @type {string} */ c) => JSON.parse(run(dir, call(c)).stdout).hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(reason("git -C 'a\nb' push origin"), /\n/);
  assert.ok(reason(`git -C . push ${"x ".repeat(5000)}`).length < 900);
  assert.ok(reason(`git -C . push ${"x ".repeat(50000)}`).length < 900, "past the ceiling too");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(reason("git -C . push \u001b[2J"), /\u001b/);
});

test("push hook: a plain push and every other command pass, printing nothing; on a pass and a refusal alike it asks git nothing", () => {
  const dir = project("{}\n");
  const log = join(dir, ".git", "calls");
  const PATH = countingGit(log);
  for (const c of ["git push origin main", "git add . && git push origin main 2>&1 | tail -3", "cd sub && git push", "git status", "ls", 'git commit -m "git -C . push"', "docker push x"]) assert.equal(run(dir, call(c), { PATH }).stdout, "", c);
  for (const c of ["git -C . push", "git commit -F - <<'E'\nx\nE\ngit push"]) assert.equal(decision(run(dir, call(c), { PATH })), "deny", c);
  assert.equal(existsSync(log), false, "no git call");
});

test("push hook: a repository's git settings decide nothing: an earlier call's core.worktree still refuses", () => {
  const dir = project("{}\n");
  execFileSync("git", ["config", "core.worktree", "/nonexistent"], { cwd: dir });
  assert.equal(decision(run(dir, call("git -C . push"))), "deny");
});

test("push hook: a Monitor on a socket holds no command and runs none: it passes with no word, and a call with neither is still said", () => {
  const dir = project("{}\n");
  assert.equal(run(dir, { tool_name: "Monitor", tool_input: { ws: { url: "ws://127.0.0.1:9/x" }, description: "x" } }).stdout, "");
  assert.deepEqual(Object.keys(JSON.parse(run(dir, { tool_name: "Monitor", tool_input: {} }).stdout)), ["systemMessage"]);
  assert.deepEqual(Object.keys(JSON.parse(run(dir, { tool_name: "Bash", tool_input: { ws: {} } }).stdout)), ["systemMessage"]);
});

test("push hook: a broken or missing catalog still refuses, with a plain English line", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-push-copy-")));
  const top = fileURLToPath(new URL("..", import.meta.url));
  for (const d of ["adapters", "core", "i18n"]) cpSync(join(top, d), join(box, d), { recursive: true });
  const repo = project("{}\n");
  const go = () => spawnSync(process.execPath, [join(box, "adapters/claude-code/hooks/push-spellings.mjs")], { input: JSON.stringify(call("git -C . push")), env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, cwd: neutral, encoding: "utf8", timeout: 20000 });
  for (const damage of [() => writeFileSync(join(box, "i18n", "en.json"), "{ broken"), () => rmSync(join(box, "i18n", "en.json"))]) {
    damage();
    const r = go();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^ennyn: .*git push <remote> <branch>/);
  }
});

test("push hook: repoOnly stops at the first folder git would stop at, and the other hooks' walk goes on", () => {
  const above = realpathSync(mkdtempSync(join(tmpdir(), "en-push-walk-")));
  mkdirSync(join(above, ".ennyn"));
  writeFileSync(join(above, ".ennyn", "config.json"), "{}\n");
  const held = (/** @type {string} */ name) => join(above, name);
  /** A folder below the config, with `make` done in it. @param {string} name @param {(dir: string) => void} make */
  const repo = (name, make) => {
    mkdirSync(held(name));
    make(held(name));
    return held(name);
  };
  // What git stops at: a .git with a HEAD, a .git file, a link to a repository.
  const real = repo("real", (d) => {
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
  });
  assert.equal(mayHold(real, ".ennyn/config.json"), true);
  assert.equal(mayHold(real, ".ennyn/config.json", true), false);
  assert.equal(mayHold(repo("file", (d) => writeFileSync(join(d, ".git"), "gitdir: /x\n")), ".ennyn/config.json", true), false);
  assert.equal(mayHold(repo("linked", (d) => symlinkSync(join(real, ".git"), join(d, ".git"))), ".ennyn/config.json", true), false);
  // What git walks past, so `mkdir .git` in a subfolder silences nothing: an empty folder, a dangling link.
  assert.equal(mayHold(repo("empty", (d) => mkdirSync(join(d, ".git"))), ".ennyn/config.json", true), true);
  assert.equal(mayHold(repo("dangling", (d) => symlinkSync(join(d, "nowhere"), join(d, ".git"))), ".ennyn/config.json", true), true);
  assert.equal(mayHold(above, ".ennyn/config.json", true), true);
});

test("push hook: with no config it ends at once: no output, no git, on a spelling and on input it cannot read, a config above the repository not counting", () => {
  const dir = project(null);
  const log = join(dir, ".git", "calls");
  const PATH = countingGit(log);
  for (const input of [call("git -C . push"), "not json", {}, { tool_input: {} }]) assert.equal(run(dir, input, { PATH }).stdout, "", JSON.stringify(input));
  assert.equal(existsSync(log), false);
  // The same for a config in a folder above the repository, which is not this project's; below its top one counts.
  const above = realpathSync(mkdtempSync(join(tmpdir(), "en-push-above-")));
  mkdirSync(join(above, ".ennyn"));
  writeFileSync(join(above, ".ennyn", "config.json"), "{}\n");
  const inner = join(above, "repo");
  mkdirSync(inner);
  execFileSync("git", ["init", "-q"], { cwd: inner });
  assert.equal(run(inner, call("git -C . push")).stdout, "");
  assert.equal(run(inner, "not json").stdout, "");
  const session = join(above, "plain", "sub");
  mkdirSync(session, { recursive: true });
  assert.equal(decision(run(session, call("git -C . push"))), "deny", "no repository: the walk goes on up");
  const deep = join(inner, "deep");
  mkdirSync(deep);
  assert.equal(run(deep, call("git -C . push")).stdout, "", "a repository above the session stops the walk");
  mkdirSync(join(inner, ".ennyn"));
  writeFileSync(join(inner, ".ennyn", "config.json"), "{}\n");
  assert.equal(decision(run(deep, call("git -C . push"))), "deny", "a session started below the top");
});

test("push hook: with no config the command's text is not even read: the reader never runs", () => {
  const marks = realpathSync(mkdtempSync(join(tmpdir(), "en-push-mark-")));
  const mark = join(marks, "read");
  const seen = join(marks, "seen.mjs");
  writeFileSync(seen, `import { writeFileSync } from "node:fs";\nconst split = String.prototype.split;\nString.prototype.split = function (a, ...r) {\n  if (a === "\\u0000") writeFileSync(${JSON.stringify(mark)}, "");\n  return split.call(this, a, ...r);\n};\n`);
  assert.equal(run(project(null), call("git -C . push"), {}, ["--import", seen]).stdout, "");
  assert.equal(existsSync(mark), false, "the reader ran with no config");
  // The control: with a config the same preload sees the reader run.
  run(project("{}\n"), call("git -C . push"), {}, ["--import", seen]);
  assert.equal(existsSync(mark), true);
});

test("push hook: a config that does not load is the project's: it still refuses, and it still says what it cannot read", () => {
  const dir = project("{ broken");
  assert.equal(decision(run(dir, call("git -C . push"))), "deny");
  assert.match(JSON.parse(run(dir, "not json").stdout).systemMessage, /could not read/);
  assert.equal(run(dir, call("git status")).stdout, "");
});

test("push hook: a place it cannot look at may hold a config: it reads and refuses", { skip: process.getuid?.() === 0 ? "root looks at every folder" : false }, () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-push-closed-")));
  const dir = join(box, "repo");
  mkdirSync(join(dir, ".ennyn"), { recursive: true });
  writeFileSync(join(dir, ".ennyn", "config.json"), "{}\n");
  chmodSync(box, 0);
  try {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(call("git -C . push")), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, cwd: neutral, encoding: "utf8", timeout: 20000 });
    assert.equal(decision(r), "deny");
  } finally {
    chmodSync(box, 0o700);
  }
});

test("push hook: a config at either place means Ennyn's project: ENNYN_CONFIG adds one and does not switch the other off", () => {
  const dir = project(null);
  const file = join(dir, "named.json");
  writeFileSync(file, "{}\n");
  assert.equal(decision(run(dir, call("git -C . push"), { ENNYN_CONFIG: file })), "deny");
  assert.equal(decision(run(dir, call("git -C . push"), { ENNYN_CONFIG: "named.json" })), "deny");
  assert.equal(run(dir, call("git -C . push"), { ENNYN_CONFIG: join(dir, "none.json") }).stdout, "");
  const held = project("{}\n");
  assert.equal(decision(run(held, call("git -C . push"), { ENNYN_CONFIG: join(held, "none.json") })), "deny");
  assert.equal(decision(run(held, call("git -C . push"), { ENNYN_CONFIG: "nope.json" })), "deny");
});

test("push hook: input it cannot read leaves the call and says so: no deny, one message, exit 0", () => {
  const dir = project("{}\n");
  for (const input of ["not json", "", "null", "[]", "{}", { tool_input: {} }, { tool_input: { command: 1 } }, { tool_input: null }]) {
    const out = JSON.parse(run(dir, input).stdout);
    assert.deepEqual(Object.keys(out), ["systemMessage"], JSON.stringify(input));
    assert.match(out.systemMessage, /could not read/);
    assert.match(out.systemMessage, /ask rule, if it has one, still stands/);
  }
});

test("push hook: a reader that fails is input it cannot read: the call runs and it is said, never a silent pass", () => {
  const dir = project("{}\n");
  const fault = join(neutral, "reader-fault.mjs");
  // The word splitter's separator is the reader's alone.
  writeFileSync(fault, 'const split = String.prototype.split;\nString.prototype.split = function (a, ...r) {\n  if (a === "\\u0000") throw new Error("reader fault");\n  return split.call(this, a, ...r);\n};\n');
  const out = JSON.parse(run(dir, call("git -C . push"), {}, ["--import", fault]).stdout);
  assert.deepEqual(Object.keys(out), ["systemMessage"]);
});

test("push hook: an alias set in the session's environment is refused, past git and with no git call before the refusal", () => {
  const dir = project("{}\n");
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "alias.save", GIT_CONFIG_VALUE_0: "push" };
  assert.equal(decision(run(dir, call("git save"), env)), "deny");
  assert.equal(decision(run(dir, call("git save"), { ...env, GIT_CONFIG_VALUE_0: "status" })), "deny");
  assert.equal(run(dir, call("git status"), env).stdout, "");
  assert.equal(run(dir, call("git save")).stdout, "");
});
