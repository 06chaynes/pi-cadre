class ConicProjection:
    def __init__(self, r0):
        self.r0 = r0
    def project(self, lat, lon):
        return lat * self.r0, lon * self.r0
