<?php
/**
 * Dev harness router: serves the test UI locally and proxies every /api/*
 * call through to a real FPP device, so the browser sees one origin and
 * CORS never enters the picture.
 *
 * Target device is fixed here deliberately — this harness is for driving a
 * known fixture, not a general proxy.
 */

const FPP_HOST = '172.16.0.59';

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (str_starts_with($uri, '/api/')) {
    $url = 'http://' . FPP_HOST . $_SERVER['REQUEST_URI'];
    $method = $_SERVER['REQUEST_METHOD'];
    $body = file_get_contents('php://input');

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_TIMEOUT => 6,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    ]);
    if ($body !== '' && $body !== false) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $out = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    unset($ch); // curl_close() is deprecated as of PHP 8.5 and is a no-op since 8.0

    header('Content-Type: application/json');
    if ($out === false || $code === 0) {
        http_response_code(502);
        echo json_encode(['proxyError' => $err ?: 'no response from ' . FPP_HOST]);
    } else {
        http_response_code($code);
        echo $out;
    }
    exit;
}

if ($uri === '/' || $uri === '') {
    readfile(__DIR__ . '/mh-test.html');
    exit;
}

return false;
