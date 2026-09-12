#!/usr/bin/env python3
"""dsh-pdf2zh 翻译引擎：结构化段落 → LLM API（OpenAI/Anthropic 兼容）批量翻译。

dsh-pdf2zh 插件（v0.8 快速管线）的配置全部来自环境变量，由插件宿主注入：
- PDF2ZH_VLLM_URL   provider baseURL（须含 /v1；openai）或 anthropic base
- PDF2ZH_API        'openai'（默认）| 'anthropic'
- PDF2ZH_MODEL      模型 id
- PDF2ZH_API_KEY    明文 key（可空 = 不带鉴权头）
- PDF2ZH_CONCURRENCY 篇内并发请求数（默认 8）
- PDF2ZH_GLOSSARY   术语表路径
- PDF2ZH_TEMPERATURE 采样温度（默认 0.3）

翻译是机械任务：openai 协议显式关闭思考（chat_template_kwargs.enable_thinking=false），
单请求输出被批大小（~3600 字符）天然限制，不做整篇长生成。
"""
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

DEFAULT_URL = "http://127.0.0.1:8003/v1"
DEFAULT_MODEL = "Qwen3.8-27B-FP8-256k"
GLOSSARY_PATH = os.environ.get("PDF2ZH_GLOSSARY") or os.path.expanduser(
    "~/.dsh/skills/pdf2zh/glossary.md")

BATCH_MAX_CHARS = 3600   # 单请求输入字符上限（控制输出在 max_tokens 内）
BATCH_MAX_PARAS = 14
MAX_TOKENS = 16384
RETRIES = 3
BACKOFF = (2, 5, 15)
REQUEST_TIMEOUT = 600
# 篇内并发请求数；vLLM continuous batching 下并发≈吞吐线性扩展
CONCURRENCY = max(1, int(os.environ.get("PDF2ZH_CONCURRENCY", "8")))

SYSTEM_PROMPT = """你是学术论文英译中引擎。把用户给出的带编号英文段落逐段翻译成中文，严格遵守：
1. 只输出编号译文，格式严格为“序号. 译文”（每行一段，序号与输入一一对应，数量相同）；
2. 模型名、数据集名、指标名（如 mIoU、OA、kappa）、引用编号（如 [12]）、URL、代码符号一律保留原文；
3. 数字、单位、超参数原样保留（如 82.3%、4×4、1e-4）；
4. 公式与数学符号（含 LaTeX）保留原文，不翻译；段落中的 ⟨数字⟩ 占位符（如 ⟨1⟩）代表公式位置，必须原样保留在对应位置，不翻译、不删除、不改变序号；
5. 章节号前缀（如“3.”）保留；
6. 学术书面中文，长句按中文习惯断句，不要口语化，不要添加解释或注释。"""

# ---------------------------------------------------------------- 在途计数

_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT = [0]
_tls = threading.local()


def in_flight():
    with _INFLIGHT_LOCK:
        return _INFLIGHT[0]


def _in_flight_add(delta):
    with _INFLIGHT_LOCK:
        _INFLIGHT[0] = max(0, _INFLIGHT[0] + delta)


def _thread_session():
    s = getattr(_tls, "session", None)
    if s is None:
        s = requests.Session()
        _tls.session = s
    return s


def load_api_key():
    # 宿主已把明文 key 放进 PDF2ZH_API_KEY；兼容读取用户 shell 里的 QWEN38_API_KEY。
    return os.environ.get("PDF2ZH_API_KEY") or os.environ.get("QWEN38_API_KEY") or ""


class Translator:
    def __init__(self, url=None, model=None, temperature=None):
        self.api = (os.environ.get("PDF2ZH_API") or "openai").strip().lower()
        if self.api not in ("openai", "anthropic"):
            self.api = "openai"
        self.url = (url or os.environ.get("PDF2ZH_VLLM_URL", DEFAULT_URL)).rstrip("/")
        self.model = model or os.environ.get("PDF2ZH_MODEL", DEFAULT_MODEL)
        self.temperature = (
            temperature if temperature is not None
            else float(os.environ.get("PDF2ZH_TEMPERATURE", "0.3")))
        self.key = load_api_key()
        self.errors = []  # 首批失败的原始错误（供调用方做质量闸门）

    def _is_anthropic(self):
        return self.api == "anthropic"

    def _messages_url(self):
        if self._is_anthropic():
            return self.url + "/messages" if self.url.endswith("/v1") else self.url + "/v1/messages"
        return self.url + "/chat/completions"

    def _models_url(self):
        return self.url + "/models"

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self._is_anthropic():
            h["anthropic-version"] = "2023-06-01"
            if self.key:
                h["x-api-key"] = self.key
        elif self.key:
            h["Authorization"] = "Bearer " + self.key
        return h

    def health(self):
        """可达性探活：任何 HTTP 应答都算活着（鉴权/模型错误会在首批翻译请求上
        以明确异常快速暴露，这里不做语义判断——/models 在部分 vLLM 部署下需
        独立鉴权，返回 401 属正常）。"""
        try:
            _thread_session().get(self._models_url(), headers=self._headers(), timeout=10)
            return True
        except Exception:
            return False

    def _load_glossary(self):
        try:
            with open(GLOSSARY_PATH, encoding="utf-8") as f:
                g = f.read().strip()
            if g:
                return "\n术语表（必须一致使用）：\n" + g
        except OSError:
            pass
        return ""

    @staticmethod
    def _parse_numbered(text):
        """解析 “1. 译文” 行 → {序号: 译文}。"""
        out = {}
        for line in text.splitlines():
            m = re.match(r"^\s*(\d+)\s*[\.、)]\s*(.+)$", line)
            if m:
                out[int(m.group(1))] = m.group(2).strip()
        return out

    def _complete(self, user):
        """一次补全：返回 (content, finish_reason)。协议自适应，异常直接抛出。"""
        sys_prompt = SYSTEM_PROMPT + self._load_glossary()
        _in_flight_add(1)
        try:
            if self._is_anthropic():
                payload = {
                    "model": self.model,
                    "temperature": self.temperature,
                    "max_tokens": min(MAX_TOKENS, 8192),
                    "system": sys_prompt,
                    "messages": [{"role": "user", "content": user}],
                }
            else:
                payload = {
                    "model": self.model,
                    "temperature": self.temperature,
                    "max_tokens": MAX_TOKENS,
                    # 翻译是机械任务：显式关闭思考模式（vLLM/Qwen3 混合模型）
                    "chat_template_kwargs": {"enable_thinking": False},
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": user},
                    ],
                }
            r = _thread_session().post(self._messages_url(), headers=self._headers(),
                                       json=payload, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            data = r.json()
            if self._is_anthropic():
                content = "".join(
                    b.get("text", "") for b in data.get("content", [])
                    if b.get("type") == "text")
                return content, data.get("stop_reason", "")
            choice = data.get("choices", [{}])[0]
            content = (choice.get("message") or {}).get("content") or ""
            return content, choice.get("finish_reason", "")
        finally:
            _in_flight_add(-1)

    def _translate_once(self, texts):
        """单次请求 → 编号译文列表（严格：缺段/截断都算失败）。"""
        user = "\n".join("%d. %s" % (i + 1, t) for i, t in enumerate(texts))
        content, finish = self._complete(user)
        if finish in ("length", "max_tokens"):
            raise ValueError("模型输出被截断（finish_reason=length）")
        parsed = self._parse_numbered(content)
        if not parsed:
            raise ValueError("模型输出无法解析为编号译文")
        missing = [i + 1 for i in range(len(texts)) if i + 1 not in parsed]
        if missing:
            raise ValueError("译文缺少编号: %s" % missing[:5])
        return [parsed[i + 1] for i in range(len(texts))]

    def translate_batch(self, texts):
        """texts: [str]，返回 [str]（失败项为 None，由调用方占位）。线程安全。"""
        last_err = None
        for attempt in range(RETRIES + 1):
            try:
                return self._translate_once(texts)
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < RETRIES:
                    time.sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
        # 最后兜底：半成功解析（缺号的段落由调用方占位）
        user = "\n".join("%d. %s" % (i + 1, t) for i, t in enumerate(texts))
        try:
            content, _ = self._complete(user)
            parsed = self._parse_numbered(content)
            if parsed:
                return [parsed.get(i + 1) for i in range(len(texts))]
        except Exception:
            pass
        raise RuntimeError("翻译失败（重试后仍失败）: %s" % last_err)

    def translate_paragraphs(self, paragraphs, progress_cb=None):
        """paragraphs: [Paragraph]。返回 {pid: 译文}。失败段落值为 None。

        篇内并发：把段落切成分批（标题单独成批），用 CONCURRENCY 个线程并行翻译。
        """
        units = []          # 每个 unit = 一个翻译批次 [Paragraph, ...]
        batch = []
        for p in paragraphs:
            if p.is_heading:  # 标题单独成批（短文本，上下文干净）
                if batch:
                    units.append(batch)
                    batch = []
                units.append([p])
                continue
            if len(batch) >= BATCH_MAX_PARAS or (
                    batch and sum(len(x.text) for x in batch) + len(p.text) > BATCH_MAX_CHARS):
                units.append(batch)
                batch = []
            batch.append(p)
        if batch:
            units.append(batch)

        results = {}
        total = len(paragraphs)
        done_box = [0]
        lock = threading.Lock()

        def work(unit):
            try:
                trans = self.translate_batch([p.text for p in unit])
            except Exception as e:  # noqa: BLE001
                trans = [None] * len(unit)
                with _INFLIGHT_LOCK:
                    if len(self.errors) < 3:
                        self.errors.append(re.sub(r"sk-[A-Za-z0-9\-_]{6,}", "sk-***", str(e))[:200])
            with lock:
                for p, t in zip(unit, trans):
                    results[p.pid] = t if t else None
                done_box[0] += len(unit)
                done = done_box[0]
            if progress_cb:
                progress_cb(done, total)

        if CONCURRENCY <= 1 or len(units) <= 1:
            for u in units:
                work(u)
        else:
            with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
                list(ex.map(work, units))
        return results


def append_glossary(terms):
    """terms: [str] “英文: 中文”。合并写入术语表（去重）。"""
    if not terms:
        return
    try:
        with open(GLOSSARY_PATH, encoding="utf-8") as f:
            existing = f.read()
        have = set(re.findall(r"^-?\s*([A-Za-z][A-Za-z0-9 \-/\(\)]*):", existing, re.M))
        new = [t for t in terms if t.split(":")[0].strip() not in have]
        if new:
            with open(GLOSSARY_PATH, "a", encoding="utf-8") as f:
                f.write("\n## pdf2zh-web 自动追加\n" if "自动追加" not in existing else "\n")
                for t in new:
                    f.write("- %s\n" % t)
    except OSError:
        pass