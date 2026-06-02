#include "wled.h"

class LedWesteUsermod : public Usermod
{
public:
    static const char mode_circle_str[] PROGMEM;
    static void mode_circle();

    static const char mode_blinking_stripe_str[] PROGMEM;
    static void mode_blinking_stripe();

    void setup() override
    {
        strip.addEffect(255, &mode_circle, mode_circle_str);
        strip.addEffect(255, &mode_blinking_stripe, mode_blinking_stripe_str);
    }

    void loop() override
    {
    }
};

// Break light
const char LedWesteUsermod::mode_circle_str[] = "Circle@,Softness,Center X,Center Y,Radius;!,!;;2;ix=0,c1=0,c2=14,c3=7";
void LedWesteUsermod::mode_circle()
{
    const auto fg = SEGCOLOR(0);
    const auto bg = SEGCOLOR(1);

    const int cx = int(SEGMENT.custom1) - 1;
    const int cy = int(SEGMENT.custom2) - 1;
    const int radius = SEGMENT.custom3;
    const int softness = SEGMENT.intensity >> 5;

    SEGMENT.fill(bg);

    const int radius2 = radius * radius;
    const auto floorDiv2 = [](int v) {
        return v >= 0 ? v / 2 : -((-v + 1) / 2);
    };
    const int edgeRadius = radius + softness;
    const int minX = floorDiv2(cx - edgeRadius) - 1;
    const int maxX = floorDiv2(cx + edgeRadius) + 1;
    const int minY = floorDiv2(cy - edgeRadius) - 1;
    const int maxY = floorDiv2(cy + edgeRadius) + 1;

    for (int y = minY; y <= maxY; y++)
    {
        const int dy = (y << 1) - cy;
        for (int x = minX; x <= maxX; x++)
        {
            const int dx = (x << 1) - cx;
            const int distance2 = dx * dx + dy * dy;
            if (distance2 <= radius2) {
                SEGMENT.setPixelColorXY(x, y, fg);
            } else if (softness && distance2 <= edgeRadius * edgeRadius) {
                const float distance = sqrtf(float(distance2));
                const uint8_t blend = constrain(int((float(edgeRadius) - distance) * 255.0f / softness), 0, 255);
                SEGMENT.setPixelColorXY(x, y, color_blend(bg, fg, blend));
            }
        }
    }
}

// Blinking vertical stripe
const char LedWesteUsermod::mode_blinking_stripe_str[] = "Blinking Stripe@!,Duty cycle,Begin,End,Run-in;!,!;;2;c1=2,c2=7";
void LedWesteUsermod::mode_blinking_stripe()
{
    if (!SEGENV.allocateData(sizeof(uint32_t))) {
        return;
    }
    auto& startTime = *reinterpret_cast<uint32_t*>(SEGENV.data);
    if (SEGENV.call == 0) {
        startTime = strip.now;
    }
    const auto effectTime = strip.now - startTime;

    const auto width = SEGMENT.virtualWidth();
    const auto height = SEGMENT.virtualHeight();

    const int xStart = SEGMENT.custom1;
    const int xStop = SEGMENT.custom2;
    const auto runIn = SEGMENT.custom3;
    const bool stripeWrapsX = SEGMENT.wrap_x && width > 0 && xStart > xStop;

    const auto fg = SEGCOLOR(0);
    const auto bg = SEGCOLOR(1);

    uint32_t cycleTime = (255 - SEGMENT.speed) * 20;
    uint32_t const onTime = FRAMETIME + ((cycleTime * SEGMENT.intensity) >> 8);
    cycleTime += FRAMETIME * 2;
    uint32_t const it = effectTime / cycleTime;
    uint32_t const rem = effectTime % cycleTime;

    bool on = SEGMENT.speed == 0; // always on when speed == 0
    if (it != SEGENV.step         // new iteration, force on state for one frame, even if set time is too brief
        || rem <= onTime)
    {
        on = true;
    }

    SEGENV.step = it; // save previous iteration

    const auto wrappedDistance = [width](int from, int to) {
        int distance = (to - from) % width;
        if (distance < 0) distance += width;
        return distance;
    };
    const int stripeWidth = stripeWrapsX ? wrappedDistance(xStart, xStop) : max(0, xStop - xStart);
    const int maxDepth = stripeWidth / 2;
    int depth = maxDepth;
    if (runIn > 0) {
        depth = (maxDepth + 1) * rem * 31 / (runIn * onTime);
    }

    SEGMENT.fill(bg);
    if (on)
    {
        depth = min(depth, maxDepth);
        for (int xDepth = 0; xDepth <= depth; ++xDepth)
        {
            for (int y = 0; y < height; ++y)
            {
                SEGMENT.setPixelColorXY(xStart + xDepth, y, fg);
                SEGMENT.setPixelColorXY(xStop - xDepth, y, fg);
            }
        }
    }
}

static LedWesteUsermod led_weste_usermod;
REGISTER_USERMOD(led_weste_usermod);
