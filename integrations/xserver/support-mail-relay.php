<?php
declare(strict_types=1);

const SECRET_FILE = '/home/andu2021/.nen-support-relay-secret';
const FROM_EMAIL = 'contact-shed@nen-petfood.com';

/**
 * 差出人の表示名。
 *
 * musubo（管理画面の SaaS）と 然-NEN-（ペットフード）は同じ送信経路を共有する。
 * 固定にしていたため musubo の会員登録メールが「然-NEN- お客様窓口」から届いて
 * いた（2026-09-30 指摘）。Worker が送ってくる `fromName` を使うが、許可した名前
 * と丸ごと一致しない限り既定値に落とす。一致方式なので改行を混ぜた名前は通らず、
 * From ヘッダーを書き換えられない。
 */
const FROM_NAME_DEFAULT = '然-NEN- お客様窓口';
const FROM_NAME_ALLOWED = ['然-NEN- お客様窓口', 'musubo'];

header('Content-Type: application/json; charset=UTF-8');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}
$body = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_NEN_TIMESTAMP'] ?? '';
$signature = strtolower($_SERVER['HTTP_X_NEN_SIGNATURE'] ?? '');
$secret = trim((string) @file_get_contents(SECRET_FILE));
if (!preg_match('/^\d{10}$/', $timestamp) || abs(time() - (int) $timestamp) > 300 ||
    !preg_match('/^[0-9a-f]{64}$/', $signature) || strlen($secret) < 32 ||
    !hash_equals(hash_hmac('sha256', $timestamp . '.' . $body, $secret), $signature)) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Invalid signature']);
    exit;
}
$input = json_decode($body, true);
$to = is_array($input) ? ($input['to'] ?? '') : '';
$subject = is_array($input) ? ($input['subject'] ?? '') : '';
$text = is_array($input) ? ($input['body'] ?? '') : '';
if (!filter_var($to, FILTER_VALIDATE_EMAIL) || !is_string($subject) || !is_string($text) ||
    $text === '' || strlen($text) > 50000) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Invalid message']);
    exit;
}
$requestedFromName = is_array($input) && is_string($input['fromName'] ?? null) ? $input['fromName'] : '';
$fromName = in_array($requestedFromName, FROM_NAME_ALLOWED, true) ? $requestedFromName : FROM_NAME_DEFAULT;
$messageId = '<' . bin2hex(random_bytes(16)) . '@nen-petfood.com>';
$cleanHeader = static fn(mixed $value): string => preg_replace('/[\r\n]+/', ' ', is_string($value) ? $value : '');
$headers = [
    'From: =?UTF-8?B?' . base64_encode($fromName) . '?= <' . FROM_EMAIL . '>',
    'Reply-To: <' . FROM_EMAIL . '>',
    'Message-ID: ' . $messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    // 本文を丸ごと base64 にすると迷惑メール判定の材料になる（本文が読めないため）。
    // quoted-printable なら日本語も送れて、素のままの行が残る（2026-09-30）。
    'Content-Transfer-Encoding: quoted-printable',
];
if (!empty($input['inReplyTo'])) $headers[] = 'In-Reply-To: ' . $cleanHeader($input['inReplyTo']);
if (!empty($input['references'])) $headers[] = 'References: ' . $cleanHeader($input['references']);
$encodedSubject = '=?UTF-8?B?' . base64_encode($cleanHeader($subject)) . '?=';
// 改行を CRLF に揃えてから符号化する。混ざると受信側で行が崩れる。
$encodedBody = quoted_printable_encode(preg_replace("/\r\n|\r|\n/", "\r\n", $text));
$sent = mail($to, $encodedSubject, $encodedBody, implode("\r\n", $headers), '-f' . FROM_EMAIL);
if (!$sent) {
    http_response_code(502);
    echo json_encode(['success' => false, 'error' => 'Mail delivery failed']);
    exit;
}
echo json_encode(['success' => true, 'messageId' => $messageId]);
