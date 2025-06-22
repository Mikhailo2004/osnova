<?php
$event = $_GET['event'] ?? 'visit';
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
$country = 'Unknown';
try {
    $info = @file_get_contents("https://ipapi.co/{$ip}/country_name/");
    if ($info) {
        $country = trim($info);
    }
} catch (Exception $e) {
}
$line = date('c')."\t{$event}\t{$ip}\t{$country}\t{$userAgent}\n";
file_put_contents(__DIR__ . '/visitors.log', $line, FILE_APPEND);
echo 'ok';
